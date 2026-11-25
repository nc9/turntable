// Onboarding lane D: the reader agent token (no step-up), `token.first_used` and `onboarding_ack`.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createOnboarding,
  type Db,
  getOnboarding,
  listAudit,
  listEvents,
  setOnboardingFirstRun,
} from "../src/db";
import * as s from "../src/db/schema";
import { createMcpHttp, MCP_PATH } from "../src/mcp/http";
import { type Credential, dispatch, type DispatchEnv, type Principal, registry } from "../src/ops";
import { SESSION_WRITE_OPS } from "../src/ops/dispatch";
import {
  ACK_LIMIT,
  MCP_URL_PATH,
  ONBOARDING_TOKEN_NAME,
} from "../src/ops/definitions/onboarding-agent";
import { MAX_ACTIVE_ONBOARDING_TOKENS } from "../src/ops/onboarding-schemas";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

// Near the real clock: the rate limit compares `now` with the audit rows' own timestamps.
const NOW = Date.now();
const DAY = 86_400_000;
const URL_BASE = "https://ci.example.test";
let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, now: () => NOW, publicUrl: `${URL_BASE}/`, transport: "rest" };
});

const session = (
  t: Tenant,
  role: "owner" | "admin" | "member" | "viewer" = "admin",
): Principal => ({
  kind: "session",
  id: "user-1",
  orgId: t.orgId,
  role,
  sessionHash: "h",
});
const asSession = (
  t: Tenant,
  name: string,
  input: Record<string, unknown>,
  role = "admin" as const,
) => dispatch(env, { kind: "principal", principal: session(t, role) }, name, input);
const asToken = (secret: string, name: string, input: Record<string, unknown> = {}, e = env) =>
  dispatch(e, { kind: "bearer", token: secret } as Credential, name, input);

type Res = Awaited<ReturnType<typeof dispatch>>;
const code = (r: Res): string => (r.ok ? "ok" : r.error.code);
type Minted = {
  token: string;
  token_id: string;
  expires_at: number;
  mcp_url: string;
  setup: { claude_command: string; mcp_json: string };
  prompt: string;
};
const mint = async (t: Tenant, input: Record<string, unknown> = {}): Promise<Minted> => {
  const r = await asSession(t, "create_onboarding_agent_token", input);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.output as Minted;
};
const eventsOf = async (t: Tenant, type: s.EventType) =>
  listEvents(db, { orgId: t.orgId }, { after: 0, limit: 100, types: [type] });

/** An onboarding whose first run is the tenant's seeded run, finished as success. */
async function onboardingWithRun(t: Tenant): Promise<string> {
  const ob = await createOnboarding(db, { orgId: t.orgId });
  await setOnboardingFirstRun(db, { orgId: t.orgId }, ob.id, t.runId, NOW);
  await db.run((h) =>
    h.orm.update(s.runs).set({ status: "success" }).where(eq(s.runs.id, t.runId)),
  );
  return ob.id;
}

describe("create_onboarding_agent_token", () => {
  test("wiring: a session write, REST only, admin", () => {
    const op = registry.get("create_onboarding_agent_token")!;
    expect(SESSION_WRITE_OPS.has("create_onboarding_agent_token")).toBe(true);
    expect(op.mcp).toBe(false);
    expect(op.auth.type === "token" && op.auth.minRole).toBe("admin");
    expect(registry.get("onboarding_ack")?.mcp).toBe(true);
    expect(MCP_URL_PATH).toBe(MCP_PATH);
  });

  test("a session mints with no step-up: an agent-kind reader, org-wide, with the TTL", async () => {
    const out = await mint(a, { ttl_days: 7 });
    expect(out.expires_at).toBe(NOW + 7 * DAY);
    expect(out.mcp_url).toBe(`${URL_BASE}/mcp`);
    const row = (await db.run((h) => h.orm.select().from(s.apiTokens))).find(
      (r) => r.id === out.token_id,
    )!;
    expect(row).toMatchObject({
      orgId: a.orgId,
      projectId: null,
      role: "reader",
      kind: "agent",
      name: ONBOARDING_TOKEN_NAME,
    });
    expect(out.setup.claude_command).toBe(
      `claude mcp add --transport http turntable ${URL_BASE}/mcp --header "Authorization: Bearer ${out.token}"`,
    );
    const cfg = JSON.parse(out.setup.mcp_json);
    expect(JSON.stringify(cfg)).toContain(out.token);
    expect(JSON.stringify(cfg)).toContain(`${URL_BASE}/mcp`);
  });

  test("the default lifetime is 30 days; 31 is refused", async () => {
    expect((await mint(a)).expires_at).toBe(NOW + 30 * DAY);
    expect(code(await asSession(a, "create_onboarding_agent_token", { ttl_days: 31 }))).toBe(
      "invalid_input",
    );
  });

  test("a project of this org scopes the token; another org's project is refused", async () => {
    const out = await mint(a, { projects: [a.projectSlug] });
    const row = (await db.run((h) => h.orm.select().from(s.apiTokens))).find(
      (r) => r.id === out.token_id,
    )!;
    expect(row.projectId).toBe(a.projectId);
    // Both orgs have a project named "app": make one that only B has.
    const { createProject } = await import("../src/db");
    await createProject(db, { orgId: b.orgId }, { slug: "only-b", name: "B" });
    expect(
      code(await asSession(a, "create_onboarding_agent_token", { projects: ["only-b"] })),
    ).toBe("not_found");
    expect(
      code(await asSession(a, "create_onboarding_agent_token", { projects: ["app", "x"] })),
    ).toBe("invalid_input");
  });

  test("the sixth active one is refused; revoking or expiry frees a slot", async () => {
    for (let n = 0; n < MAX_ACTIVE_ONBOARDING_TOKENS; n++) await mint(a);
    const r = await asSession(a, "create_onboarding_agent_token", {});
    expect(code(r)).toBe("conflict");
    if (!r.ok) {
      expect(r.error.message).toBe(
        "this org has 5 active onboarding agent tokens; revoke one in Tokens first",
      );
    }
    // Another org is unaffected.
    await mint(b);
    const first = (await db.run((h) => h.orm.select().from(s.apiTokens))).find(
      (r) => r.orgId === a.orgId && r.name === ONBOARDING_TOKEN_NAME,
    )!;
    await db.run((h) =>
      h.orm.update(s.apiTokens).set({ revokedAt: NOW }).where(eq(s.apiTokens.id, first.id)),
    );
    await mint(a);
  });

  test("only an owner or admin session: members, viewers, tokens and MCP are refused", async () => {
    expect(code(await asSession(a, "create_onboarding_agent_token", {}, "member" as never))).toBe(
      "forbidden",
    );
    const admin = await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "person" });
    expect(code(await asToken(admin.secret, "create_onboarding_agent_token"))).toBe("forbidden");
    expect(
      code(
        await dispatch(
          { ...env, viaMcp: true },
          { kind: "principal", principal: session(a) },
          "create_onboarding_agent_token",
          {},
        ),
      ),
    ).toBe("forbidden");
    expect(code(await asSession(b, "create_onboarding_agent_token", { org: "org-a" }))).toBe(
      "not_found",
    );
  });

  test("needs a public URL", async () => {
    const r = await dispatch(
      { ...env, publicUrl: undefined },
      { kind: "principal", principal: session(a) },
      "create_onboarding_agent_token",
      {},
    );
    expect(code(r)).toBe("unavailable");
  });

  test("minting above reader from a session still needs a step-up", async () => {
    const r = await asSession(a, "create_api_token", { name: "x", role: "operator" });
    expect(code(r)).toBe("forbidden");
  });

  test("onboarding_id records the token and fills the prompt from the first run", async () => {
    const id = await onboardingWithRun(a);
    const out = await mint(a, { onboarding_id: id });
    expect((await getOnboarding(db, { orgId: a.orgId }, id))?.agentTokenId).toBe(out.token_id);
    const sha = "a".repeat(40);
    expect(out.prompt).toBe(
      "Use the turntable MCP server. Call `whoami`. " +
        `Then find the run for \`org-a/app\` at commit \`${sha}\` with \`list_runs\`, read it with \`get_run\`, ` +
        "and call `onboarding_ack` with its `run_id`. Report the run's conclusion and job results.",
    );
    // Another org's onboarding is not found.
    const other = await createOnboarding(db, { orgId: b.orgId });
    expect(
      code(await asSession(a, "create_onboarding_agent_token", { onboarding_id: other.id })),
    ).toBe("not_found");
  });

  test("the prompt never contains the token, with or without an onboarding", async () => {
    const id = await onboardingWithRun(a);
    for (const input of [{}, { onboarding_id: id }]) {
      const out = await mint(a, input);
      expect(out.prompt).not.toContain(out.token);
      expect(out.prompt).not.toContain("Bearer");
    }
  });

  test("no token material in audit, events or logs", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
    let out: Minted;
    try {
      out = await mint(a, { projects: [a.projectSlug] });
      // Use it too, so the first-use path runs under the spies.
      await asToken(out.token, "whoami");
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    const secretPart = out.token.slice(3);
    const audit = JSON.stringify(await listAudit(db, { orgId: a.orgId }, { limit: 50 }));
    const events = JSON.stringify(
      await listEvents(db, { orgId: a.orgId }, { after: 0, limit: 100 }),
    );
    for (const hay of [audit, events, logs.join("\n")]) {
      expect(hay).not.toContain(out.token);
      expect(hay).not.toContain(secretPart);
    }
    const entry = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).find(
      (e) => e.op === "create_onboarding_agent_token",
    )!;
    expect(entry.principalKind).toBe("session");
    expect(entry.outcome).toBe("ok");
    expect(entry.input).toContain(out.token_id);
    expect(entry.input).toContain(a.projectSlug);
    expect(entry.input).toContain('"role":"reader"');
    expect(entry.input).toContain("ttl_days");
  });
});

const rpc = (token: string, tool: string, args: Record<string, unknown> = {}) =>
  new Request(`${URL_BASE}${MCP_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });

describe("token.first_used", () => {
  test("an MCP call emits exactly one event; later calls emit none", async () => {
    const out = await mint(a);
    const mcp = createMcpHttp({ ...env, transport: "mcp", viaMcp: true });
    const res = await mcp(rpc(out.token, "whoami"));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toContain("reader");
    const ev = await eventsOf(a, "token.first_used");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload)).toEqual({ token_id: out.token_id, principal_kind: "agent" });
    await mcp(rpc(out.token, "whoami"));
    await asToken(out.token, "whoami");
    expect(await eventsOf(a, "token.first_used")).toHaveLength(1);
    const row = (await db.run((h) => h.orm.select().from(s.apiTokens))).find(
      (r) => r.id === out.token_id,
    )!;
    expect(row.firstUsedAt).toBe(NOW);
  });

  test("concurrent first calls still emit one", async () => {
    const out = await mint(a);
    await Promise.all(Array.from({ length: 6 }, () => asToken(out.token, "whoami")));
    expect(await eventsOf(a, "token.first_used")).toHaveLength(1);
  });

  test("the event goes to the token's own org only, with no secret", async () => {
    const out = await mint(a);
    await asToken(out.token, "whoami");
    expect(await eventsOf(b, "token.first_used")).toHaveLength(0);
    const ev = await eventsOf(a, "token.first_used");
    expect(ev[0]!.projectId).toBeNull();
    expect(JSON.stringify(ev)).not.toContain(out.token);
  });

  test("a revoked or unknown token stamps nothing", async () => {
    const out = await mint(a);
    await db.run((h) =>
      h.orm.update(s.apiTokens).set({ revokedAt: NOW }).where(eq(s.apiTokens.id, out.token_id)),
    );
    expect(code(await asToken(out.token, "whoami"))).toBe("unauthenticated");
    expect(await eventsOf(a, "token.first_used")).toHaveLength(0);
  });

  test("an ordinary person token emits it with principal_kind person", async () => {
    const t = await mintToken(db, { orgId: a.orgId }, "reader", { kind: "person" });
    await asToken(t.secret, "whoami");
    const ev = await eventsOf(a, "token.first_used");
    expect(JSON.parse(ev[0]!.payload)).toEqual({ token_id: t.id, principal_kind: "person" });
  });
});

describe("the onboarding token cannot write", () => {
  test("cancel, rerun, settings and tokens are forbidden", async () => {
    const secret = (await mint(a)).token;
    const org = { org: "org-a" };
    const other = await mint(a);
    const cases: [string, Record<string, unknown>][] = [
      ["cancel", { run_id: a.runId }],
      ["rerun", { run_id: a.runId }],
      ["set_setting", { key: "approval_policy", value: "{}" }],
      ["set_secret", { name: "X", value: "y" }],
      ["set_quotas", {}],
      ["create_api_token", { name: "x", role: "reader" }],
      ["create_onboarding_agent_token", {}],
    ];
    for (const [op, input] of cases) {
      if (!registry.get(op)) throw new Error(`unknown op in test: ${op}`);
      expect(code(await asToken(secret, op, { ...org, ...input }))).toBe("forbidden");
    }
    // It cannot revoke a token it did not mint (the op answers not_found), and the target lives.
    const rev = await asToken(secret, "revoke_api_token", {
      token_id: other.token_id,
      reason: "x",
    });
    expect(code(rev)).toBe("not_found");
    expect(code(await asToken(other.token, "whoami"))).toBe("ok");
    // It can read.
    expect(code(await asToken(secret, "list_runs"))).toBe("ok");
  });
});

describe("onboarding_ack", () => {
  test("returns the conclusion and jobs of an onboarding's first run, and emits the event", async () => {
    await onboardingWithRun(a);
    const { token: secret, token_id } = await mint(a);
    const r = await asToken(secret, "onboarding_ack", { run_id: a.runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toEqual({
      run_id: a.runId,
      conclusion: "success",
      jobs: [{ name: "build", conclusion: null }],
    });
    const ev = await eventsOf(a, "onboarding.agent_ack");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload)).toEqual({ run_id: a.runId, token_id });
    // Recorded: the audit entry names the token and the run.
    const entry = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).find(
      (e) => e.op === "onboarding_ack",
    )!;
    expect(entry.principalId).toBe(token_id);
    expect(entry.input).toContain(a.runId);
  });

  test("works through MCP too", async () => {
    await onboardingWithRun(a);
    const { token } = await mint(a);
    const mcp = createMcpHttp({ ...env, transport: "mcp", viaMcp: true });
    const res = await mcp(rpc(token, "onboarding_ack", { run_id: a.runId }));
    expect(await res?.text()).toContain(a.runId);
    expect(await eventsOf(a, "onboarding.agent_ack")).toHaveLength(1);
  });

  test("a run that is no onboarding's first run, or another org's, is not_found", async () => {
    const secret = (await mint(a)).token;
    // a's run exists but no onboarding points at it.
    expect(code(await asToken(secret, "onboarding_ack", { run_id: a.runId }))).toBe("not_found");
    // b's onboarding first run is invisible to a's token.
    await onboardingWithRun(b);
    expect(code(await asToken(secret, "onboarding_ack", { run_id: b.runId }))).toBe("not_found");
    expect(code(await asToken(secret, "onboarding_ack", { run_id: "nope" }))).toBe("not_found");
    expect(await eventsOf(a, "onboarding.agent_ack")).toHaveLength(0);
  });

  test("the first run of ANY onboarding of the org counts (not unique per org)", async () => {
    const one = await createOnboarding(db, { orgId: a.orgId });
    const two = await createOnboarding(db, { orgId: a.orgId });
    await setOnboardingFirstRun(db, { orgId: a.orgId }, one.id, "other-run", NOW);
    await setOnboardingFirstRun(db, { orgId: a.orgId }, two.id, a.runId, NOW);
    const secret = (await mint(a)).token;
    expect(code(await asToken(secret, "onboarding_ack", { run_id: a.runId }))).toBe("ok");
  });

  test("a project-scoped token cannot ack a run of another project", async () => {
    await onboardingWithRun(a);
    const { createProject } = await import("../src/db");
    await createProject(db, { orgId: a.orgId }, { slug: "second", name: "Second" });
    const secret = (await mint(a, { projects: ["second"] })).token;
    expect(code(await asToken(secret, "onboarding_ack", { run_id: a.runId }))).toBe("not_found");
    const wide = (await mint(a)).token;
    expect(code(await asToken(wide, "onboarding_ack", { run_id: a.runId }))).toBe("ok");
  });

  test("a burst is rate limited per token", async () => {
    await onboardingWithRun(a);
    const one = (await mint(a)).token;
    const two = (await mint(a)).token;
    for (let n = 0; n < ACK_LIMIT; n++) {
      expect(code(await asToken(one, "onboarding_ack", { run_id: a.runId }))).toBe("ok");
    }
    expect(code(await asToken(one, "onboarding_ack", { run_id: a.runId }))).toBe("rate_limited");
    // Another token has its own budget.
    expect(code(await asToken(two, "onboarding_ack", { run_id: a.runId }))).toBe("ok");
  });
});
