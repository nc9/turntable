// The per-project `untrusted_run_approval` policy (#322): who may release a run held for an
// untrusted author through approve_run, the token `kind` it reads, and who may change either.
// Every policy value against every caller: MCP, REST with an agent and a person token, a
// kind-less legacy token, and the local CLI person. Runs on both dialects.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createJob,
  createProject,
  getOrgBySlug,
  createRun,
  type Db,
  getProjectSandboxSettings,
  getRun,
  listAudit,
  listJobs,
  setApproveRunMinRole,
  setProjectSandboxSettings,
  type Scope,
} from "../src/db";
import { TOKEN_KINDS, type UntrustedRunApproval, UNTRUSTED_RUN_APPROVALS } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry, type Credential } from "../src/ops";
import { approvalRefusal } from "../src/ops/approval-policy";
import { mcpTools } from "../src/ops/mcp";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { setSandboxPolicy } from "../src/ops/policy-cli";
import { assertMintable, generateToken, hashToken } from "../src/ops/tokens";
import { createTokenFromCli, listTokensFromCli } from "../src/ops/token-cli";
import { bootstrapToken } from "../src/ops/bootstrap";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let p2: Required<Scope>; // a second project in org a
let seq = 0;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  const project = await createProject(db, { orgId: a.orgId }, { slug: "second", name: "Second" });
  p2 = { orgId: a.orgId, projectId: project.id };
});

/** A run held for an untrusted author, with the sha and workflow hash approve_run must be given. */
async function held(scope: Scope, over: { ref?: string; cls?: string } = {}) {
  seq += 1;
  const sha = createHash("sha1").update(`held-${seq}`).digest("hex");
  const workflowHash = createHash("sha256").update(`wf-${seq}`).digest("hex");
  const run = await createRun(db, scope as Required<Scope>, {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    ref: over.ref ?? "refs/pull/7/head",
    sha,
    trust: JSON.stringify({ class: over.cls ?? "untrusted_pr", workflowHash }),
  });
  const job = (await createJob(db, scope as Required<Scope>, {
    runId: run.id,
    jobKey: "build",
    name: "build",
    approvalKind: "untrusted_author",
  }))!;
  await db.run((h) =>
    rawExec(h.orm, sql`update jobs set state = 'awaiting_approval' where id = ${job.id}`),
  );
  return { runId: run.id, input: { run_id: run.id, head_sha: sha, workflow_hash: workflowHash } };
}

const jobStates = async (scope: Scope, runId: string) =>
  (await listJobs(db, scope, runId)).map((j) => j.state);

type Caller = "mcp-person" | "mcp-agent" | "rest-agent" | "rest-person" | "rest-legacy" | "cli";
const CALLERS: Caller[] = [
  "mcp-person",
  "mcp-agent",
  "rest-agent",
  "rest-person",
  "rest-legacy",
  "cli",
];

/** A token minted before `kind` existed: inserted without the column, so it takes the default. */
async function legacyToken(scope: Scope): Promise<string> {
  const secret = generateToken();
  await db.run((h) =>
    rawExec(
      h.orm,
      sql`insert into api_tokens (id, org_id, project_id, name, role, token_hash, created_by)
          values (${`legacy-${++seq}`}, ${scope.orgId}, ${null}, 'legacy', 'release_operator',
                  ${hashToken(secret)}, 'test:setup')`,
    ),
  );
  return secret;
}

async function callAs(caller: Caller, scope: Scope, name: string, input: Record<string, unknown>) {
  const org = { orgId: scope.orgId };
  const env: DispatchEnv = { registry, db };
  if (caller === "cli") {
    const member: Credential = {
      kind: "principal",
      principal: { kind: "member", id: "cli:local", orgId: scope.orgId, role: "admin" },
    };
    return dispatch(env, member, name, input);
  }
  const secret =
    caller === "rest-legacy"
      ? await legacyToken(scope)
      : (
          await mintToken(db, org, "release_operator", {
            kind: caller.endsWith("person") ? "person" : "agent",
          })
        ).secret;
  return dispatch(
    { ...env, transport: caller.startsWith("mcp") ? "mcp" : "rest" },
    { kind: "bearer", token: secret },
    name,
    input,
  );
}

// Who may approve under each policy: the whole table, written out.
const ALLOWED: Record<UntrustedRunApproval, Record<Caller, boolean>> = {
  human: {
    "mcp-person": false,
    "mcp-agent": false,
    "rest-agent": false,
    "rest-person": false,
    "rest-legacy": false,
    cli: false,
  },
  no_agents: {
    "mcp-person": false,
    "mcp-agent": false,
    "rest-agent": false,
    "rest-person": true,
    "rest-legacy": false,
    cli: true,
  },
  any: {
    "mcp-person": true,
    "mcp-agent": true,
    "rest-agent": true,
    "rest-person": true,
    "rest-legacy": true,
    cli: true,
  },
};

describe("approve_run under each policy", () => {
  test("a new project defaults to no_agents", async () => {
    expect((await getProjectSandboxSettings(db, a.scope)).untrustedRunApproval).toBe("no_agents");
  });

  for (const policy of UNTRUSTED_RUN_APPROVALS) {
    for (const caller of CALLERS) {
      const allowed = ALLOWED[policy][caller];
      test(`${policy}: ${caller} ${allowed ? "may approve" : "is refused"}`, async () => {
        await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: policy });
        const h = await held(a.scope);
        const r = await callAs(caller, a.scope, "approve_run", h.input);
        if (allowed) {
          expect(r.ok).toBe(true);
          expect(await jobStates(a.scope, h.runId)).toEqual(["queued"]);
          expect((await getRun(db, a.scope, h.runId))!.approval).not.toBeNull();
        } else {
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.error.code).toBe("forbidden");
          expect(r.error.message).toContain(
            policy === "human" ? "approval_requires_human" : "agents_may_not_approve",
          );
          // refused means nothing moved
          expect(await jobStates(a.scope, h.runId)).toEqual(["awaiting_approval"]);
          expect((await getRun(db, a.scope, h.runId))!.approval).toBeNull();
        }
      });
    }
  }

  test("a refusal is audited with the caller kind, the transport and the policy", async () => {
    const h = await held(a.scope);
    await callAs("mcp-person", a.scope, "approve_run", h.input);
    await callAs("rest-agent", a.scope, "approve_run", h.input);
    await callAs("rest-legacy", a.scope, "approve_run", h.input);
    const rows = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).filter(
      (x) => x.op === "approve_run",
    );
    expect(rows.map((x) => x.outcome)).toEqual(Array(3).fill("error:forbidden"));
    expect(rows.map((x) => JSON.parse(x.input)).toReversed()).toMatchObject([
      {
        refused: "agents_may_not_approve",
        policy: "no_agents",
        caller_kind: "person",
        transport: "mcp",
      },
      {
        refused: "agents_may_not_approve",
        caller_kind: "agent",
        transport: "rest",
        run_id: h.runId,
      },
      { refused: "agents_may_not_approve", caller_kind: "agent", transport: "rest" },
    ]);
  });

  test("human mode is audited as approval_requires_human", async () => {
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "human" });
    const h = await held(a.scope);
    await callAs("rest-person", a.scope, "approve_run", h.input);
    const [row] = await listAudit(db, { orgId: a.orgId }, { limit: 1 });
    expect(JSON.parse(row!.input)).toMatchObject({
      refused: "approval_requires_human",
      policy: "human",
      caller_kind: "person",
      transport: "rest",
    });
  });

  test("a release tag run still needs release_operator, whatever the policy says", async () => {
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "any" });
    await setApproveRunMinRole(db, a.orgId, "operator");
    const tag = await held(a.scope, { ref: "refs/tags/v1.0.0", cls: "release" });
    const op = (await mintToken(db, { orgId: a.orgId }, "operator", { kind: "person" })).secret;
    const r = await dispatch(
      { registry, db, transport: "rest" },
      { kind: "bearer", token: op },
      "approve_run",
      tag.input,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("release_operator");
  });

  test("a project's setting never reaches another project, in this org or another", async () => {
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "any" });
    await setProjectSandboxSettings(db, b.scope, { untrustedRunApproval: "human" });
    // project a allows an agent; the second project of the same org still has the default
    const own = await held(a.scope);
    expect((await callAs("rest-agent", a.scope, "approve_run", own.input)).ok).toBe(true);
    const sibling = await held(p2);
    const refused = await callAs("rest-agent", p2, "approve_run", sibling.input);
    expect(refused.ok).toBe(false);
    expect(await jobStates(p2, sibling.runId)).toEqual(["awaiting_approval"]);
    // org b is `human`; org a's `any` does not loosen it, and b's tokens cannot touch a's runs
    const other = await held(b.scope);
    expect((await callAs("rest-person", b.scope, "approve_run", other.input)).ok).toBe(false);
    expect((await getProjectSandboxSettings(db, b.scope)).untrustedRunApproval).toBe("human");
    const crossed = await callAs("rest-person", b.scope, "approve_run", {
      ...(await held(a.scope)).input,
    });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.error.code).toBe("not_found");
  });

  test("the pure rule: unknown transport is not mcp, but an agent token is always refused", () => {
    const agent = {
      kind: "token",
      id: "t",
      orgId: "o",
      projectId: null,
      role: "operator",
      tokenKind: "agent",
    } as const;
    const person = { ...agent, tokenKind: "person" } as const;
    expect(
      approvalRefusal("no_agents", { principal: person, transport: undefined }),
    ).toBeUndefined();
    expect(approvalRefusal("no_agents", { principal: agent, transport: undefined })?.reason).toBe(
      "agents_may_not_approve",
    );
    expect(approvalRefusal("no_agents", { principal: person, transport: "mcp" })?.reason).toBe(
      "agents_may_not_approve",
    );
    expect(approvalRefusal("human", { principal: person, transport: "rest" })?.reason).toBe(
      "approval_requires_human",
    );
    expect(approvalRefusal("any", { principal: agent, transport: "mcp" })).toBeUndefined();
  });

  test("the MCP tool says what the policy is and how to escalate", () => {
    const tool = mcpTools(registry).find((t) => t.name === "approve_run")!;
    expect(tool.description).toContain("untrusted_run_approval");
    expect(tool.description).toContain("agents_may_not_approve");
    expect(tool.description).toContain("tell a person");
  });
});

describe("changing the setting", () => {
  const env: DispatchEnv = { registry, db: undefined as unknown as Db, allowInstance: true };
  let secret: string;
  beforeEach(async () => {
    env.db = db;
    secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  });
  const asInstance = (input: Record<string, unknown>) =>
    dispatch(env, { kind: "bearer", token: secret }, "set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      ...input,
    });

  test("raising to any is the instance administrator's and is audited with old and new", async () => {
    const r = await asInstance({ untrusted_run_approval: "any" });
    expect(r.ok && (r.output as { untrusted_run_approval: string }).untrusted_run_approval).toBe(
      "any",
    );
    expect((await getProjectSandboxSettings(db, a.scope)).untrustedRunApproval).toBe("any");
    const own = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(JSON.parse(own!.input)).toMatchObject({
      from: { untrustedRunApproval: "no_agents" },
      to: { untrustedRunApproval: "any" },
    });
    // lowering is audited the same way
    await asInstance({ untrusted_run_approval: "no_agents" });
    const [latest] = (await listAudit(db, { orgId: a.orgId }, { limit: 5 })).filter(
      (x) => x.op === "set_project_settings",
    );
    expect(JSON.parse(latest!.input)).toMatchObject({
      from: { untrustedRunApproval: "any" },
      to: { untrustedRunApproval: "no_agents" },
    });
  });

  test("human is selectable through the op and the host CLI, audited with old and new", async () => {
    const r = await asInstance({ untrusted_run_approval: "human" });
    expect(r.ok && (r.output as { untrusted_run_approval: string }).untrusted_run_approval).toBe(
      "human",
    );
    expect((await getProjectSandboxSettings(db, a.scope)).untrustedRunApproval).toBe("human");
    await setSandboxPolicy(db, "org-a", "app", { untrustedRunApproval: "no_agents" });
    await setSandboxPolicy(db, "org-a", "app", { untrustedRunApproval: "human" });
    expect((await getProjectSandboxSettings(db, a.scope)).untrustedRunApproval).toBe("human");
    const own = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(JSON.parse(own!.input)).toMatchObject({
      from: { untrustedRunApproval: "no_agents" },
      to: { untrustedRunApproval: "human" },
    });
  });

  test("no org token, of any role or kind, can set it, and it is not an MCP tool", async () => {
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("set_project_settings");
    for (const kind of TOKEN_KINDS) {
      const tok = (await mintToken(db, { orgId: a.orgId }, "release_operator", { kind })).secret;
      const r = await dispatch(
        { registry, db, transport: "rest" },
        { kind: "bearer", token: tok },
        "set_project_settings",
        {
          target_org: "org-a",
          target_project: "app",
          untrusted_run_approval: "any",
        },
      );
      expect(r.ok).toBe(false);
    }
    const member = await dispatch(
      { registry, db },
      { kind: "principal", principal: a.admin },
      "set_project_settings",
      { target_org: "org-a", target_project: "app", untrusted_run_approval: "any" },
    );
    expect(member.ok).toBe(false);
    expect((await getProjectSandboxSettings(db, a.scope)).untrustedRunApproval).toBe("no_agents");
  });

  test("a bad value is refused, and get_project_settings reports it", async () => {
    expect((await asInstance({ untrusted_run_approval: "agents" })).ok).toBe(false);
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "human" });
    const tok = (await mintToken(db, a.scope, "reader", { kind: "agent" })).secret;
    const r = await dispatch(
      { registry, db, transport: "mcp" },
      { kind: "bearer", token: tok },
      "get_project_settings",
      {},
    );
    expect(r.ok && (r.output as { untrusted_run_approval: string }).untrusted_run_approval).toBe(
      "human",
    );
  });

  test("the host CLI sets it and audits the change", async () => {
    const r = await setSandboxPolicy(db, "org-a", "app", { untrustedRunApproval: "any" });
    expect(r.from.untrustedRunApproval).toBe("no_agents");
    expect(r.to.untrustedRunApproval).toBe("any");
    await expect(
      setSandboxPolicy(db, "org-a", "app", { untrustedRunApproval: "all" }),
    ).rejects.toThrow(/one of/);
    const row = (await listAudit(db, { orgId: a.orgId }, { limit: 5 })).find(
      (x) => x.op === "policy_set",
    );
    expect(JSON.parse(row!.input)).toMatchObject({ to: { untrustedRunApproval: "any" } });
  });
});

describe("token kind", () => {
  const member = (orgId: string) => ({ kind: "member", id: "u", orgId, role: "admin" }) as const;
  const mint = (kind?: string) =>
    dispatch(
      { registry, db },
      { kind: "principal", principal: member(a.orgId) },
      "create_api_token",
      { name: "t", role: "reader", ...(kind ? { kind } : {}) },
    );

  test("a token is an agent unless minted as a person, and the kind is stored", async () => {
    const dflt = await mint();
    expect(dflt.ok && (dflt.output as { kind: string }).kind).toBe("agent");
    const person = await mint("person");
    expect(person.ok && (person.output as { kind: string }).kind).toBe("person");
    expect((await mint("robot")).ok).toBe(false);
    const rows = await listTokensFromCli(db, { org: "org-a" });
    expect(rows.map((r) => r.kind).toSorted()).toEqual(["agent", "person"]);
  });

  test("the CLI mints either kind, defaulting to agent, and rejects others", async () => {
    const d = await createTokenFromCli(db, { org: "org-a", role: "reader", name: "d" });
    const p = await createTokenFromCli(db, {
      org: "org-a",
      role: "reader",
      name: "p",
      kind: "person",
    });
    expect([d.kind, p.kind]).toEqual(["agent", "person"]);
    await expect(
      createTokenFromCli(db, { org: "org-a", role: "reader", name: "x", kind: "robot" }),
    ).rejects.toThrow(/unknown kind/);
    const audit = (await listAudit(db, { orgId: a.orgId }, { limit: 5 })).find(
      (x) => x.op === "create_api_token",
    );
    expect(JSON.parse(audit!.input)).toMatchObject({ kind: "person" });
  });

  test("a token minted before kind existed is an agent", async () => {
    const secret = await legacyToken(a.scope);
    const r = await dispatch(
      { registry, db, transport: "rest" },
      { kind: "bearer", token: secret },
      "whoami",
      {},
    );
    expect(r.ok).toBe(true);
    const rows = await listTokensFromCli(db, { org: "org-a" });
    expect(rows.find((x) => x.name === "legacy")!.kind).toBe("agent");
  });

  test("a token never mints a less restricted kind than its own", () => {
    const base = {
      kind: "token",
      id: "t",
      orgId: "o",
      projectId: null,
      role: "release_operator",
    } as const;
    const agent = { ...base, tokenKind: "agent" } as const;
    const person = { ...base, tokenKind: "person" } as const;
    expect(() =>
      assertMintable(agent, { role: "reader", projectId: undefined, kind: "person" }),
    ).toThrow(/agent token cannot create a person/);
    expect(() =>
      assertMintable(agent, { role: "reader", projectId: undefined, kind: "agent" }),
    ).not.toThrow();
    expect(() =>
      assertMintable(person, { role: "reader", projectId: undefined, kind: "person" }),
    ).not.toThrow();
    expect(() =>
      assertMintable(person, { role: "reader", projectId: undefined, kind: "agent" }),
    ).not.toThrow();
  });

  test("no operation changes a token's kind, and minting is not an MCP tool", () => {
    const mcpNames = mcpTools(registry).map((t) => t.name);
    expect(mcpNames).not.toContain("create_api_token");
    expect(mcpNames).not.toContain("create_org_token");
    expect(registry.ops.find((o) => o.name === "create_org_token")!.mcp).toBe(false);
    const withKind = registry.ops.filter((o) => "kind" in o.input.shape).map((o) => o.name);
    // create_org_token: instance-admin only, REST only, first token of an org only.
    expect(withKind).toEqual(["create_api_token", "create_org_token"]);
  });
});

describe("the human path under no_agents", () => {
  test("the web UI's approve, with a person-kind session token, succeeds", async () => {
    // The UI calls POST /runs/{id}/approve with its bearer token, over REST.
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "no_agents" });
    const h = await held(a.scope);
    const ui = (await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "person" }))
      .secret;
    const r = await dispatch(
      { registry, db, transport: "rest" },
      { kind: "bearer", token: ui },
      "approve_run",
      h.input,
    );
    expect(r.ok).toBe(true);
    expect(await jobStates(a.scope, h.runId)).toEqual(["queued"]);
  });

  test("the bootstrap token is a person token, and it is audited as one", async () => {
    const secret = generateToken();
    const res = await bootstrapToken(db, { sha256: hashToken(secret), org: "org-fresh" });
    expect(res.status).toBe("created");
    const rows = await listTokensFromCli(db, { org: "org-fresh" });
    expect(rows.map((r) => [r.name, r.kind])).toEqual([["bootstrap", "person"]]);
    const org = (await getOrgBySlug(db, "org-fresh"))!;
    const audit = (await listAudit(db, { orgId: org.id }, { limit: 5 })).find(
      (x) => x.op === "create_api_token",
    );
    expect(JSON.parse(audit!.input)).toMatchObject({ kind: "person" });
  });

  test("a signed approval op does not consult the run policy, so WebAuthn works under no_agents", () => {
    // approve_environment is a signature op: the enrolled approver's proof is the credential and
    // approve_run's untrusted_run_approval is read only in approve_run's handler. The signed path
    // for a held run is the `human` mode and stays closed in this round (see QUESTION.md).
    const op = registry.ops.find((o) => o.name === "approve_environment")!;
    expect(op.auth.type).toBe("signature");
    expect(
      approvalRefusal("no_agents", {
        principal: { kind: "approver", id: "k", orgId: "o", person: "p", role: "viewer" },
        transport: "rest",
      }),
    ).toBeUndefined();
  });
});

describe("minting a person token", () => {
  test("an agent token minting a person token is refused and audited", async () => {
    const agent = (await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "agent" }))
      .secret;
    const r = await dispatch(
      { registry, db, transport: "rest" },
      { kind: "bearer", token: agent },
      "create_api_token",
      { name: "sneaky", role: "reader", kind: "person" },
    );
    expect(r.ok).toBe(false);
    expect((await listTokensFromCli(db, { org: "org-a" })).map((t) => t.name)).not.toContain(
      "sneaky",
    );
    const rows = (await listAudit(db, { orgId: a.orgId }, { limit: 10 })).filter(
      (x) => x.op === "create_api_token",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toStartWith("error:");
  });
});
