// Onboarding, connect an agent (lane D): the one token a web session may mint with no step-up,
// and the ack an agent calls to prove it can see the first run. Schemas are the shared ones in
// ../onboarding-schemas.ts.
//
// Why no step-up is safe here: the token is a `reader` (it cannot write anything), agent kind,
// lives at most 30 days, and an org holds at most 5 active ones. Anything above that still goes
// through `create_api_token` with a passkey step-up.
import {
  appendEvent,
  countActiveTokensNamed,
  countAuditEntries,
  getOnboarding,
  getOrgById,
  getProjectBySlug,
  getRunRow,
  insertApiToken,
  isOnboardingFirstRun,
  listJobs,
  lockOrgTokens,
  setOnboardingAgentToken,
} from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import {
  createOnboardingAgentTokenInput,
  createOnboardingAgentTokenOutput,
  MAX_ACTIVE_ONBOARDING_TOKENS,
  onboardingAckInput,
  onboardingAckOutput,
  ONBOARDING_TOKEN_SECRET_FIELDS,
} from "../onboarding-schemas";
import { principalLabel } from "../principal";
import { roleSatisfies } from "../roles";
import { generateToken, hashToken } from "../tokens";

const DAY_MS = 86_400_000;

/** The label every onboarding token carries; the active-token cap counts by it. */
export const ONBOARDING_TOKEN_NAME = "onboarding agent";
/** The path the MCP endpoint is served at (mcp/http.ts MCP_PATH; a test keeps the two equal). */
export const MCP_URL_PATH = "/mcp";
/** `onboarding_ack` calls one token may make per window. */
export const ACK_LIMIT = 10;
export const ACK_WINDOW_MS = 60_000;

/** Run states that are an outcome; anything else has no conclusion yet. */
const FINAL = new Set(["success", "failure", "infra_error", "cancelled", "skipped"]);
const conclusionOf = (state: string): string | null => (FINAL.has(state) ? state : null);

export const createOnboardingAgentToken = defineOp({
  name: "create_onboarding_agent_token",
  // Credential minting never goes over MCP: a token must not be minted into an agent's context.
  mcp: false,
  summary: "Mint a read-only agent token for onboarding, with the setup command and a prompt.",
  description:
    "For the onboarding wizard's last step. Mints an agent token with the `reader` role, scoped " +
    "to the org or to one project of it (`projects`, at most one: a token covers the org or one " +
    "project), valid `ttl_days` (1 to 30, default 30) and labelled `onboarding agent`. This is " +
    "the only mint a web session can make with no passkey step-up, which is why it is this " +
    "narrow: reader only, at most 30 days, at most 5 active per org (revoke one in Tokens when " +
    "the org has that many). Anything more goes through `create_api_token` with a step-up. " +
    "Returns the secret once (`token`) with the instance's `mcp_url`, `setup.claude_command` " +
    "and `setup.mcp_json` (both carry the token) and a `prompt` that never does. With " +
    "`onboarding_id` the token is recorded on that onboarding and the prompt names its first " +
    "run. Needs a signed-in web session of an org owner or admin: no token can call it, and it " +
    "is not an MCP tool. Audited with the token id, role, scope, lifetime and who minted it " +
    "(never the secret); emits `org.token_minted`.",
  input: createOnboardingAgentTokenInput,
  output: createOnboardingAgentTokenOutput,
  oneTimeSecretFields: [...ONBOARDING_TOKEN_SECRET_FIELDS],
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/onboarding/agent-token" },
  // The input (`projects`, `ttl_days`, `onboarding_id`) is audited as given, so the entry names
  // the scope and lifetime; the principal names who minted it. Never the secret fields.
  auditDetail: (out) => ({
    token_id: out.token_id,
    role: "reader",
    expires_at: new Date(out.expires_at).toISOString(),
  }),
  async handler(ctx, i) {
    const p = ctx.principal;
    if (ctx.transport === "mcp" || ctx.viaMcp) {
      throw new OpError("forbidden", "create_onboarding_agent_token is not available over MCP");
    }
    // A session only. A token (whatever its role) minting with no step-up would be an escape
    // from the step-up on create_api_token.
    if (p.kind !== "session") {
      throw new OpError("forbidden", "create_onboarding_agent_token needs a signed-in web session");
    }
    if (!roleSatisfies(p.role, "admin")) {
      throw new OpError("forbidden", "only org owners and admins can create tokens");
    }
    const publicUrl = ctx.publicUrl?.trim().replace(/\/+$/, "");
    if (!publicUrl) {
      throw new OpError("unavailable", "this instance has no public URL (TURNTABLE_PUBLIC_URL)");
    }
    const mcpUrl = `${publicUrl}${MCP_URL_PATH}`;
    const orgId = ctx.scope.orgId;
    if ((i.projects?.length ?? 0) > 1) {
      throw new OpError(
        "invalid_input",
        "a token covers the org or one project: pass at most one project",
      );
    }
    let projectId: string | undefined;
    if (i.projects?.[0] !== undefined) {
      // Another org's project and a missing one read the same.
      const project = await getProjectBySlug(ctx.db, { orgId }, i.projects[0]);
      if (!project) throw new OpError("not_found", "org or project not found");
      projectId = project.id;
    }
    const org = await getOrgById(ctx.db, orgId);
    if (!org) throw new OpError("not_found", "org not found");
    // The first run's project and commit fill in the prompt (the onboarding is this org's).
    let firstRun: { project: string; sha: string | null } | undefined;
    if (i.onboarding_id !== undefined) {
      const ob = await getOnboarding(ctx.db, { orgId }, i.onboarding_id);
      if (!ob) throw new OpError("not_found", "no such onboarding");
      if (ob.firstRunId) {
        const run = await getRunRow(ctx.db, { orgId }, ob.firstRunId);
        if (run) firstRun = { project: run.projectSlug, sha: run.sha };
      }
    }
    // Serialise with other mints and revokes, then count against fresh state.
    await lockOrgTokens(ctx.db, orgId);
    const now = ctx.now();
    if (
      (await countActiveTokensNamed(
        ctx.db,
        { orgId },
        { name: ONBOARDING_TOKEN_NAME, role: "reader" },
        now,
      )) >= MAX_ACTIVE_ONBOARDING_TOKENS
    ) {
      throw new OpError(
        "conflict",
        `this org has ${MAX_ACTIVE_ONBOARDING_TOKENS} active onboarding agent tokens; revoke one in Tokens first`,
      );
    }
    const expiresAt = now + i.ttl_days * DAY_MS;
    const secret = generateToken();
    const row = await insertApiToken(
      ctx.db,
      { orgId, ...(projectId ? { projectId } : {}) },
      {
        name: ONBOARDING_TOKEN_NAME,
        role: "reader",
        kind: "agent",
        tokenHash: hashToken(secret),
        createdBy: principalLabel(p),
        expiresAt,
      },
    );
    if (i.onboarding_id !== undefined) {
      await setOnboardingAgentToken(ctx.db, { orgId }, i.onboarding_id, row.id, now);
    }
    await appendEvent(
      ctx.db,
      { orgId },
      {
        type: "org.token_minted",
        payload: {
          token_id: row.id,
          parent_id: null,
          by: principalLabel(p),
          role: "reader",
          kind: "agent",
          project_id: row.projectId,
          expires_at: new Date(expiresAt).toISOString(),
          onboarding: true,
        },
      },
    );
    const claude = `claude mcp add --transport http turntable ${mcpUrl} --header "Authorization: Bearer ${secret}"`;
    const mcpJson = JSON.stringify(
      {
        mcpServers: {
          turntable: {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      },
      null,
      2,
    );
    const where = firstRun
      ? `the run for \`${org.slug}/${firstRun.project}\` at commit \`${firstRun.sha ?? "unknown"}\``
      : "the first run of the repository you were pointed at";
    const prompt =
      "Use the turntable MCP server. Call `whoami`. " +
      `Then find ${where} with \`list_runs\`, read it with \`get_run\`, ` +
      "and call `onboarding_ack` with its `run_id`. Report the run's conclusion and job results.";
    return {
      token: secret,
      token_id: row.id,
      expires_at: expiresAt,
      mcp_url: mcpUrl,
      setup: { claude_command: claude, mcp_json: mcpJson },
      prompt,
    };
  },
});

export const onboardingAck = defineOp({
  name: "onboarding_ack",
  summary: "Confirm an onboarding run is visible to this token; returns its conclusion.",
  description:
    "For the agent that finishes onboarding. Pass the `run_id` of the onboarding's first run " +
    "(found with `list_runs`). Returns the run's `conclusion` (null while it runs) and each " +
    "job's name and conclusion, only when the run is inside this token's scope and is the first " +
    "run of an onboarding of its org; any other run, existing or not, is `not_found`. Records " +
    "that this token acknowledged the run: the audit entry names the token and the run_id, and " +
    "an `onboarding.agent_ack` event (`run_id`, `token_id`) goes to the org's feed so the " +
    `wizard can show it. A token may call it ${ACK_LIMIT} times a minute. It changes nothing ` +
    "else. Needs a token of role reader or above.",
  input: onboardingAckInput,
  output: onboardingAckOutput,
  // A write only because it is recorded (audit and event); the token needs no more than reader.
  effect: "write",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "POST", path: "/onboarding/ack" },
  auditDetail: () => ({}),
  async handler(ctx, i) {
    const p = ctx.principal;
    if (p.kind !== "token") throw new OpError("forbidden", "onboarding_ack is for tokens");
    const scope = ctx.scope;
    // The limiter counts this token's recorded acks in the org's audit chain. The handler runs in
    // the write transaction that holds the chain's lock, so a burst cannot all pass the count.
    const recent = await countAuditEntries(ctx.db, scope, {
      op: "onboarding_ack",
      principalKind: "token",
      principalId: p.id,
      since: ctx.now() - ACK_WINDOW_MS,
    });
    if (recent >= ACK_LIMIT) {
      throw new OpError("rate_limited", `at most ${ACK_LIMIT} acknowledgements a minute per token`);
    }
    const notFound = new OpError("not_found", "no such run");
    // The scope carries the token's project, so a run outside the grant is simply not found.
    const run = await getRunRow(ctx.db, scope, i.run_id);
    if (!run || !(await isOnboardingFirstRun(ctx.db, { orgId: scope.orgId }, run.id))) {
      throw notFound;
    }
    const jobs = await listJobs(ctx.db, scope, run.id);
    await appendEvent(
      ctx.db,
      { orgId: scope.orgId },
      { type: "onboarding.agent_ack", payload: { run_id: run.id, token_id: p.id } },
    );
    return {
      run_id: run.id,
      conclusion: conclusionOf(run.status),
      jobs: jobs.map((j) => ({ name: j.name, conclusion: conclusionOf(j.state) })),
    };
  },
});
