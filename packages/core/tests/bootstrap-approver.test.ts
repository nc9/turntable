// bootstrap_approver (#341): the instance administrator enrols an org's first approver on a host
// with no shell. Single use per org, REST only, audited in both chains, never the key text.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import { generateEd25519 } from "../src/approvals/keys";
import { keyFingerprint } from "../src/approvals/statement";
import { type Db, listAudit } from "../src/db";
import { insertApprover, listApprovers, revokeApprover } from "../src/db/repos";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createMcpHttp } from "../src/mcp/http";
import { mcpTools } from "../src/ops/mcp";
import { createRestApi } from "../src/ops/rest";
import { handleRequest } from "../src/server";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let secret: string;
let tokenId: string;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, allowInstance: true };
  const made = await createInstanceTokenFromCli(db, { name: "ops laptop" });
  secret = made.secret;
  tokenId = made.id;
});

const asInstance = (input: Record<string, unknown>) =>
  dispatch(env, { kind: "bearer", token: secret }, "bootstrap_approver", input);

const input = (publicKey: string, over: Record<string, unknown> = {}) => ({
  target_org: "org-a",
  person: "Alice",
  forge_login: "alice-gh",
  public_key: publicKey,
  ...over,
});

describe("bootstrap_approver", () => {
  test("allowed with zero approvers: enrols an ed25519 approver and returns the fingerprint", async () => {
    const k = generateEd25519();
    const r = await asInstance(input(k.publicSpki));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { approver_id: string; key_fingerprint: string; warnings: string[] };
    const rows = await listApprovers(db, a.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: out.approver_id,
      person: "Alice",
      forgeLogin: "alice-gh",
      kind: "ed25519",
      createdBy: `instance:${tokenId}`,
    });
    expect(out.key_fingerprint).toBe(
      keyFingerprint({ kind: "ed25519", credentialId: null, publicKey: rows[0]!.publicKey }),
    );
    expect(out.warnings.length).toBeGreaterThan(0); // one person is not yet a two-person rule
    expect(await listApprovers(db, b.orgId)).toHaveLength(0); // other orgs untouched
  });

  test("refused once an approver exists, and it never adds to the set", async () => {
    const first = await asInstance(input(generateEd25519().publicSpki));
    expect(first.ok).toBe(true);
    const again = await asInstance(
      input(generateEd25519().publicSpki, { person: "Mallory", forge_login: "mallory" }),
    );
    expect(!again.ok && again.error.code).toBe("conflict");
    const rows = await listApprovers(db, a.orgId);
    expect(rows.map((r) => r.person)).toEqual(["Alice"]);
  });

  test("refused when an approver exists by any other path", async () => {
    await insertApprover(
      db,
      a.orgId,
      {
        person: "Bob",
        forgeLogin: "bob",
        kind: "ed25519",
        publicKey: generateEd25519().publicSpki,
        alg: "EdDSA",
        createdBy: "test",
      },
      Date.now(),
    );
    const r = await asInstance(input(generateEd25519().publicSpki));
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(await listApprovers(db, a.orgId)).toHaveLength(1);
  });

  test("an org whose approvers were all revoked can be bootstrapped again, like the CLI", async () => {
    const first = await asInstance(input(generateEd25519().publicSpki));
    if (!first.ok) throw new Error("setup");
    const id = (first.output as { approver_id: string }).approver_id;
    expect(await revokeApprover(db, a.orgId, id, Date.now())).toBe(true);
    const r = await asInstance(input(generateEd25519().publicSpki, { person: "Carol" }));
    expect(r.ok).toBe(true);
  });

  test("refused for an unknown org and for the system org; a bad key writes nothing", async () => {
    const k = generateEd25519().publicSpki;
    const unknown = await asInstance(input(k, { target_org: "no-such-org" }));
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    const sys = await asInstance(input(k, { target_org: "system" }));
    expect(!sys.ok && sys.error.code).toBe("not_found");
    const bad = await asInstance(input("not a key"));
    expect(!bad.ok && bad.error.code).toBe("invalid_input");
    expect(await listApprovers(db, a.orgId)).toHaveLength(0);
  });

  test("audited in the system chain and the org's chain, with the fingerprint and never the key", async () => {
    const k = generateEd25519();
    const r = await asInstance(input(k.publicSpki));
    if (!r.ok) throw new Error("setup");
    const fp = (r.output as { key_fingerprint: string }).key_fingerprint;
    const sysRows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const orgRows = await listAudit(db, { orgId: a.orgId }, { limit: 50 });
    for (const rows of [sysRows, orgRows]) {
      const row = rows.find((x) => x.op === "bootstrap_approver");
      expect(row).toMatchObject({ principalKind: "instance", principalId: tokenId });
      expect(row!.input).toContain(fp);
      expect(row!.input).not.toContain(k.publicSpki);
      expect(row!.input).not.toContain(k.publicSpki.replace(/-----[^-]+-----|\s/g, ""));
    }
    expect(sysRows.find((x) => x.op === "bootstrap_approver")!.outcome).toBe("ok");
    // a refusal is audited in the system chain too
    await asInstance(input(generateEd25519().publicSpki));
    const after = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    expect(after.filter((x) => x.op === "bootstrap_approver").map((x) => x.outcome)).toContain(
      "error:conflict",
    );
  });
});

describe("afterwards", () => {
  test("enrolment of a second key works as today: refused before the bootstrap, pending after it", async () => {
    const op = {
      kind: "bearer",
      token: (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret,
    } as const;
    const second = {
      person: "Alice",
      forge_login: "alice-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    };
    const before = await dispatch(env, op, "request_enrolment", second);
    expect(!before.ok && before.error.code).toBe("conflict");
    expect((await asInstance(input(generateEd25519().publicSpki))).ok).toBe(true);
    const after = await dispatch(env, op, "request_enrolment", second);
    expect(after.ok).toBe(true);
    expect(await listApprovers(db, a.orgId)).toHaveLength(1); // pending until the bootstrap key signs it
  });
});

describe("only the instance administrator, only over REST", () => {
  test("every org token of any role, a project-scoped one and every member is refused", async () => {
    const creds: Credential[] = [];
    for (const t of [a, b]) {
      for (const role of AGENT_ROLES) {
        creds.push({
          kind: "bearer",
          token: (await mintToken(db, { orgId: t.orgId }, role)).secret,
        });
      }
      creds.push({
        kind: "bearer",
        token: (await mintToken(db, t.scope, "release_operator")).secret,
      });
      for (const role of ["admin", "owner"] as const) {
        const p: Principal = { kind: "member", id: `${role}-${t.slug}`, orgId: t.orgId, role };
        creds.push({ kind: "principal", principal: p });
      }
    }
    for (const cred of creds) {
      const r = await dispatch(
        env,
        cred,
        "bootstrap_approver",
        input(generateEd25519().publicSpki),
      );
      expect(!r.ok && r.error.code).toBe("forbidden");
    }
    expect(await listApprovers(db, a.orgId)).toHaveLength(0);
    expect(await listApprovers(db, b.orgId)).toHaveLength(0);
  });

  test("REST works, MCP does not list it and rejects an instance token, plain dispatch refuses", async () => {
    const api = createRestApi({ registry, db });
    const k = generateEd25519().publicSpki;
    const rest = await handleRequest(
      new Request("http://localhost/api/v1/instance/approvers/bootstrap", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(input(k)),
      }),
      api,
    );
    expect(rest!.status).toBe(200);
    expect(await listApprovers(db, a.orgId)).toHaveLength(1);
    const mcp = createMcpHttp({ registry, db });
    const res = await mcp(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res!.status).toBe(401);
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("bootstrap_approver");
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "bootstrap_approver",
      input(generateEd25519().publicSpki, { target_org: "org-b" }),
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
    expect(await listApprovers(db, b.orgId)).toHaveLength(0);
  });
});
