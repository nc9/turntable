// Signed human approval of a run held for an untrusted author (#324): a
// `turntable.approve_run.v1` statement an enrolled approver signs, relayed through approve_run.
// Under the `human` policy it is the only thing that approves. Runs on both dialects.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import { canonicalStatement } from "../src/approvals/statement";
import {
  createJob,
  createRun,
  type Db,
  getRun,
  insertApprover,
  listAudit,
  listJobs,
  revokeApprover,
  setEnvPolicy,
  setKeyPolicy,
  setProjectSandboxSettings,
  type Scope,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let clock = 1_800_000_000_000;
let seq = 0;

type Person = { id: string; priv: string };

async function approverIn(t: Tenant, forgeLogin: string | null = "alice-gh"): Promise<Person> {
  const k = generateEd25519();
  const row = await insertApprover(
    db,
    t.orgId,
    {
      person: "Alice",
      forgeLogin,
      kind: "ed25519",
      publicKey: k.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    clock,
  );
  return { id: row.id, priv: k.privatePem };
}

/** A run held for an untrusted author, with the sha and workflow hash approve_run is given. */
async function held(t: Tenant, cls = "untrusted_pr", actor?: string) {
  seq += 1;
  const sha = createHash("sha1").update(`human-${seq}`).digest("hex");
  const workflowHash = createHash("sha256").update(`wf-human-${seq}`).digest("hex");
  const run = await createRun(db, t.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    ref: "refs/pull/7/head",
    sha,
    ...(actor ? { actor } : {}),
    trust: JSON.stringify({ class: cls, workflowHash }),
  });
  const job = (await createJob(db, t.scope, {
    runId: run.id,
    jobKey: "build",
    name: "build",
    approvalKind: "untrusted_author",
  }))!;
  await db.run((h) =>
    rawExec(h.orm, sql`update jobs set state = 'awaiting_approval' where id = ${job.id}`),
  );
  return { runId: run.id, sha, workflowHash };
}
type Held = Awaited<ReturnType<typeof held>>;

const states = async (scope: Scope, runId: string) =>
  (await listJobs(db, scope, runId)).map((j) => j.state);

async function token(t: Tenant, kind: "person" | "agent" = "person") {
  return (await mintToken(db, { orgId: t.orgId }, "release_operator", { kind })).secret;
}
const call = (tok: string, op: string, input: unknown, transport: "rest" | "mcp" = "rest") =>
  dispatch({ ...env, transport }, { kind: "bearer", token: tok }, op, input);

async function challenge(tok: string, h: Held, p: Person) {
  const r = await call(tok, "approve_run_challenge", { run_id: h.runId, approver: p.id });
  if (!r.ok) throw new Error(`approve_run_challenge: ${r.error.message}`);
  return r.output as { statement: Record<string, any>; canonical: string; statement_hash: string };
}
const sig = (p: Person, canonical: string) => ({
  kind: "ed25519" as const,
  signature: signEd25519(p.priv, canonical),
});
/** Signs `statement` as `p`, whatever it says: for statements the server would never issue. */
const selfSigned = (p: Person, statement: Record<string, any>) => ({
  statement,
  signature: sig(p, canonicalStatement(statement as never)),
});
const approve = (
  tok: string,
  h: Held,
  extra: Record<string, unknown>,
  transport?: "rest" | "mcp",
) =>
  call(
    tok,
    "approve_run",
    { run_id: h.runId, head_sha: h.sha, workflow_hash: h.workflowHash, ...extra },
    transport,
  );
const code = (r: Awaited<ReturnType<typeof dispatch>>) => (r.ok ? "ok" : r.error.code);

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  clock += 1000;
  env = { registry, db, now: () => clock };
  await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "human" });
  await setProjectSandboxSettings(db, b.scope, { untrustedRunApproval: "human" });
});

describe("a signed statement under the human policy", () => {
  test("a valid statement approves, and the audit holds its hash and approver, never the signature", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    expect(c.statement).toMatchObject({
      type: "turntable.approve_run.v1",
      org: a.slug,
      project: a.projectSlug,
      run_id: h.runId,
      head_sha: h.sha,
      trust_class: "untrusted_pr",
      approver: alice.id,
    });
    expect(c.statement.expires_at - clock).toBeLessThanOrEqual(10 * 60_000);
    const s = sig(alice, c.canonical);
    const r = await approve(tok, h, { statement: c.statement, signature: s });
    expect(r.ok && r.output).toMatchObject({
      state: "queued",
      released_jobs: 1,
      statement_hash: c.statement_hash,
      signed_by: alice.id,
    });
    expect(await states(a.scope, h.runId)).toEqual(["queued"]);
    expect(JSON.parse((await getRun(db, a.scope, h.runId))!.approval!).by).toContain(alice.id);
    const row = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).find(
      (x) => x.op === "approve_run" && x.outcome === "ok",
    )!;
    expect(JSON.parse(row.input)).toMatchObject({
      statement_hash: c.statement_hash,
      signed_approver: alice.id,
      signature: "[omitted]",
    });
    expect(row.input).not.toContain(s.signature);
  });

  test("a token alone, of any kind or transport, is refused and audited", async () => {
    await approverIn(a);
    for (const [kind, transport] of [
      ["person", "rest"],
      ["agent", "rest"],
      ["person", "mcp"],
      ["agent", "mcp"],
    ] as const) {
      const h = await held(a);
      const r = await approve(await token(a, kind), h, {}, transport);
      expect(code(r)).toBe("forbidden");
      expect(!r.ok && r.error.message).toMatch(/approval_requires_human/);
      expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
    }
    const rows = await listAudit(db, { orgId: a.orgId }, { limit: 50 });
    expect(rows.filter((x) => x.outcome === "error:forbidden").length).toBe(4);
  });

  test("an agent over MCP only relays: a statement a person signed approves, its absence does not", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const c = await challenge(await token(a), h, alice);
    const agent = await token(a, "agent");
    expect(code(await approve(agent, h, {}, "mcp"))).toBe("forbidden");
    const r = await approve(
      agent,
      h,
      { statement: c.statement, signature: sig(alice, c.canonical) },
      "mcp",
    );
    expect(r.ok).toBe(true);
    // The agent cannot make the statement: the challenge op is not an MCP tool.
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("approve_run_challenge");
    expect(mcpTools(registry).map((t) => t.name)).toContain("approve_run");
  });

  test("a statement is single-use: a replay is refused and audited", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    const signed = { statement: c.statement, signature: sig(alice, c.canonical) };
    expect((await approve(tok, h, signed)).ok).toBe(true);
    const again = await approve(tok, h, signed);
    expect(code(again)).toBe("conflict");
    expect(!again.ok && again.error.message).toMatch(/already used/);
    const rows = await listAudit(db, { orgId: a.orgId }, { limit: 20 });
    expect(rows.some((x) => x.op === "approve_run" && x.outcome === "error:conflict")).toBe(true);
  });

  test("a nonce nobody issued is refused even with a valid signature", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    const made = { ...c.statement, nonce: "q".repeat(24) };
    const r = await approve(tok, h, selfSigned(alice, made));
    expect(code(r)).toBe("conflict");
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });

  test("a statement for another run, sha, workflow, class, org or project is refused", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const other = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    const cases: [string, Record<string, unknown>, Held, RegExp][] = [
      ["run", c.statement, other, /another run/],
      ["sha", { ...c.statement, head_sha: "e".repeat(40) }, h, /head_sha/],
      ["workflow", { ...c.statement, workflow_hash: "e".repeat(64) }, h, /workflow_hash/],
      ["class", { ...c.statement, trust_class: "protected" }, h, /trust class/],
      ["org", { ...c.statement, org: "someone-else" }, h, /another org/],
      ["project", { ...c.statement, project: "elsewhere" }, h, /another project/],
    ];
    for (const [name, statement, target, why] of cases) {
      const r = await approve(tok, target, selfSigned(alice, statement));
      expect([name, code(r)]).toEqual([name, "conflict"]);
      expect(!r.ok && r.error.message).toMatch(why);
    }
    // Neither run was released, and the issued challenge is still unspent.
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
    expect(await states(a.scope, other.runId)).toEqual(["awaiting_approval"]);
    expect(
      (await approve(tok, h, { statement: c.statement, signature: sig(alice, c.canonical) })).ok,
    ).toBe(true);
  });

  test("an expired statement, and one valid for more than 10 minutes, are refused", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    const long = await approve(
      tok,
      h,
      selfSigned(alice, { ...c.statement, expires_at: clock + 11 * 60_000 }),
    );
    expect(code(long)).toBe("invalid_input");
    expect(!long.ok && long.error.message).toMatch(/10 minutes/);
    clock += 10 * 60_000 + 1;
    const late = await approve(tok, h, {
      statement: c.statement,
      signature: sig(alice, c.canonical),
    });
    expect(code(late)).toBe("invalid_input");
    expect(!late.ok && late.error.message).toMatch(/expired/);
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });

  test("a key that does not satisfy the org key policy, or does not count, is refused", async () => {
    const alice = await approverIn(a);
    const nameless = await approverIn(a, null);
    const h = await held(a);
    const tok = await token(a);
    expect(
      code(
        await approve(
          tok,
          h,
          selfSigned(nameless, {
            ...(await challenge(tok, h, nameless)).statement,
          }),
        ),
      ),
    ).toBe("forbidden");
    await setKeyPolicy(db, a.orgId, { mode: "hardware", presets: [], aaguids: [] }, "test", clock);
    const c = await challenge(tok, h, alice);
    const r = await approve(tok, h, { statement: c.statement, signature: sig(alice, c.canonical) });
    expect(code(r)).toBe("forbidden");
    expect(!r.ok && r.error.message).toMatch(/cannot approve/);
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });

  test("an approver not enrolled in the org, a revoked one, or a bad signature is refused", async () => {
    const alice = await approverIn(a);
    const eve = await approverIn(b);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    // Signed by a key of org b, naming org b's approver id: unknown in org a.
    const forged = selfSigned(eve, { ...c.statement, approver: eve.id });
    expect(code(await approve(tok, h, forged))).toBe("unauthenticated");
    // Alice's name on a statement signed by someone else's key.
    expect(
      code(await approve(tok, h, { statement: c.statement, signature: sig(eve, c.canonical) })),
    ).toBe("unauthenticated");
    await revokeApprover(db, a.orgId, alice.id, clock);
    expect(
      code(await approve(tok, h, { statement: c.statement, signature: sig(alice, c.canonical) })),
    ).toBe("unauthenticated");
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });

  test("tenants are isolated: org b's approver and tokens cannot approve or challenge org a's run", async () => {
    const eve = await approverIn(b);
    const h = await held(a);
    const tokB = await token(b);
    const c = await call(tokB, "approve_run_challenge", { run_id: h.runId, approver: eve.id });
    expect(code(c)).toBe("not_found");
    const r = await approve(tokB, h, {});
    expect(code(r)).toBe("not_found");
    const alice = await approverIn(a);
    const own = await challenge(await token(a), h, alice);
    const stolen = await approve(tokB, h, {
      statement: own.statement,
      signature: sig(alice, own.canonical),
    });
    expect(code(stolen)).toBe("not_found");
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });

  test("a statement without a signature, or the reverse, is refused", async () => {
    const alice = await approverIn(a);
    const h = await held(a);
    const tok = await token(a);
    const c = await challenge(tok, h, alice);
    expect(code(await approve(tok, h, { statement: c.statement }))).toBe("invalid_input");
    expect(code(await approve(tok, h, { signature: sig(alice, c.canonical) }))).toBe(
      "invalid_input",
    );
  });
});

describe("the other policies behave as before", () => {
  test("no_agents: a person token approves over REST, an agent token does not, even with a statement", async () => {
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "no_agents" });
    const alice = await approverIn(a);
    const h = await held(a);
    expect((await approve(await token(a), h, {})).ok).toBe(true);
    const h2 = await held(a);
    const c = await challenge(await token(a), h2, alice);
    const r = await approve(await token(a, "agent"), h2, {
      statement: c.statement,
      signature: sig(alice, c.canonical),
    });
    expect(!r.ok && r.error.message).toMatch(/agents_may_not_approve/);
  });

  test("any: a token approves without a statement, and a given statement must still verify", async () => {
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "any" });
    const alice = await approverIn(a);
    const tok = await token(a, "agent");
    expect((await approve(tok, await held(a), {}, "mcp")).ok).toBe(true);
    const h = await held(a);
    const c = await challenge(await token(a), h, alice);
    const bad = await approve(tok, h, {
      statement: c.statement,
      signature: sig(alice, "tampered"),
    });
    expect(code(bad)).toBe("unauthenticated");
    expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
  });
});

describe("the approver is not the run's author (#408)", () => {
  const signed = async (h: Held, p: Person) => {
    const tok = await token(a);
    const c = await challenge(tok, h, p);
    return approve(tok, h, { statement: c.statement, signature: sig(p, c.canonical) });
  };

  test("an approver whose linked login is the author is refused, whatever the case", async () => {
    const alice = await approverIn(a, "Alice-GH");
    for (const actor of ["alice-gh", "ALICE-GH"]) {
      const h = await held(a, "untrusted_pr", actor);
      const r = await signed(h, alice);
      expect(code(r)).toBe("forbidden");
      expect(!r.ok && r.error.message).toMatch(/approver_is_author/);
      expect(await states(a.scope, h.runId)).toEqual(["awaiting_approval"]);
    }
  });

  test("the org policy allowing author approval lets the author approve", async () => {
    const alice = await approverIn(a, "alice-gh");
    await setEnvPolicy(db, a.orgId, {
      environment: "production",
      required: 1,
      allowAuthorApproval: true,
      by: "t",
      now: clock,
    });
    const h = await held(a, "untrusted_pr", "Alice-GH");
    expect((await signed(h, alice)).ok).toBe(true);
    expect(await states(a.scope, h.runId)).toEqual(["queued"]);
  });

  test("a different approver is unaffected", async () => {
    const alice = await approverIn(a, "alice-gh");
    const h = await held(a, "untrusted_pr", "mallory");
    expect((await signed(h, alice)).ok).toBe(true);
  });
});
