// bootstrap_approver (#341): the instance administrator enrols an org's first approver on a host
// with no shell. Single use per org, REST only, audited in both chains, never the key text.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import { generateEd25519 } from "../src/approvals/keys";
import { keyFingerprint } from "../src/approvals/statement";
import { type Db, listAudit } from "../src/db";
import { revokeApproverNotifying } from "../src/approvals/apply";
import { insertApprover, listApprovers, listEvents } from "../src/db/repos";
import { createSettingsRuntime } from "../src/settings/resolve";
import { settingsRegistry } from "../src/settings/definitions";
import { AGENT_ROLES, EVENT_TYPES } from "../src/db/schema";
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

const DAY = 24 * 3_600_000;
const cli = { kind: "cli", id: "local" };

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

  test("a never-bootstrapped org has no delay", async () => {
    expect((await asInstance(input(generateEd25519().publicSpki))).ok).toBe(true);
  });

  test("after every approver is revoked, an immediate bootstrap is refused and says when", async () => {
    const t0 = Date.now();
    const clock = { ...env, now: () => t0 };
    const first = await dispatch(
      clock,
      { kind: "bearer", token: secret },
      "bootstrap_approver",
      input(generateEd25519().publicSpki),
    );
    if (!first.ok) throw new Error(`setup: ${first.error.message}`);
    const id = (first.output as { approver_id: string }).approver_id;
    expect(await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, id, t0, cli)).toBe(
      true,
    );
    const again = await dispatch(
      { ...env, now: () => t0 + 3_600_000 },
      { kind: "bearer", token: secret },
      "bootstrap_approver",
      input(generateEd25519().publicSpki, { person: "Mallory" }),
    );
    expect(!again.ok && again.error.code).toBe("conflict");
    expect(!again.ok && again.error.message).toContain(new Date(t0 + DAY).toISOString());
    expect(await listApprovers(db, a.orgId)).toHaveLength(0);
  });

  test("allowed once the delay has passed since the LAST revocation", async () => {
    const t0 = Date.now();
    const at = (now: number, person: string) =>
      dispatch(
        { ...env, now: () => now },
        { kind: "bearer", token: secret },
        "bootstrap_approver",
        input(generateEd25519().publicSpki, { person }),
      );
    const first = await at(t0, "Alice");
    const id1 = (first as { output: { approver_id: string } }).output.approver_id;
    await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, id1, t0, cli);
    // a second revocation later restarts the clock
    const second = await at(t0 + DAY, "Bob");
    expect(second.ok).toBe(true);
    const id2 = (second as { output: { approver_id: string } }).output.approver_id;
    await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, id2, t0 + DAY, cli);
    expect((await at(t0 + DAY + DAY - 1, "Carol")).ok).toBe(false);
    expect((await at(t0 + DAY + DAY, "Carol")).ok).toBe(true);
    expect((await listApprovers(db, a.orgId)).map((r) => r.person)).toEqual(["Carol"]);
  });

  test("the delay is the org's setting: shorter is honoured, below one hour is refused, an env value locks it", async () => {
    const t0 = Date.now();
    const set = (value: number) =>
      dispatch(env, { kind: "bearer", token: secret }, "instance_set_setting", {
        key: "approver_rebootstrap_delay_hours",
        value,
        target_org: "org-a",
      });
    expect((await set(0)).ok).toBe(false);
    expect((await set(2)).ok).toBe(true);
    const first = await dispatch(
      { ...env, now: () => t0 },
      { kind: "bearer", token: secret },
      "bootstrap_approver",
      input(generateEd25519().publicSpki),
    );
    const id = (first as { output: { approver_id: string } }).output.approver_id;
    await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, id, t0, cli);
    const at = (now: number) =>
      dispatch(
        { ...env, now: () => now },
        { kind: "bearer", token: secret },
        "bootstrap_approver",
        input(generateEd25519().publicSpki),
      );
    expect((await at(t0 + 2 * 3_600_000 - 1)).ok).toBe(false);
    expect((await at(t0 + 2 * 3_600_000)).ok).toBe(true);
    // the environment wins over the stored value and locks the setting
    const locked: DispatchEnv = {
      ...env,
      settings: createSettingsRuntime(settingsRegistry, {
        TURNTABLE_APPROVER_REBOOTSTRAP_DELAY_HOURS: "48",
      }),
    };
    const refused = await dispatch(
      locked,
      { kind: "bearer", token: secret },
      "instance_set_setting",
      {
        key: "approver_rebootstrap_delay_hours",
        value: 3,
        target_org: "org-a",
      },
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain(
      "TURNTABLE_APPROVER_REBOOTSTRAP_DELAY_HOURS",
    );
    const rows = await listApprovers(db, a.orgId);
    await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, rows[0]!.id, t0 + DAY, cli);
    const viaEnv = (now: number) =>
      dispatch(
        { ...locked, now: () => now },
        { kind: "bearer", token: secret },
        "bootstrap_approver",
        input(generateEd25519().publicSpki),
      );
    expect((await viaEnv(t0 + DAY + 47 * 3_600_000)).ok).toBe(false);
    expect((await viaEnv(t0 + DAY + 48 * 3_600_000)).ok).toBe(true);
  });

  test("the delay setting is instance-admin only, off MCP, and 24 hours by default", async () => {
    const def = settingsRegistry.get("approver_rebootstrap_delay_hours")!;
    expect(def).toMatchObject({ instanceAdminOnly: true, mcpEditable: false, default: 24 });
    expect(def.type.safeParse(1).success).toBe(true);
    expect(def.type.safeParse(0).success).toBe(false);
    const org = {
      kind: "bearer",
      token: (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret,
    } as const;
    const r = await dispatch(env, org, "set_setting", {
      key: "approver_rebootstrap_delay_hours",
      value: 1,
    });
    expect(r.ok).toBe(false);
  });

  test("a bootstrap and a revocation that leaves zero approvers emit an event; a partial revocation does not", async () => {
    const scope = { orgId: a.orgId };
    const r1 = await asInstance(input(generateEd25519().publicSpki));
    const id1 = (r1 as { output: { approver_id: string } }).output.approver_id;
    const id2 = (
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
      )
    ).id;
    const org = { id: a.orgId, slug: "org-a" };
    await revokeApproverNotifying(db, org, id1, Date.now(), cli);
    let types = (await listEvents(db, scope, { after: 0, limit: 50 }))
      .map((e) => e.type)
      .filter((x) => x.startsWith("approver"));
    expect(types).toEqual(["approver.bootstrapped"]);
    await revokeApproverNotifying(db, org, id2, Date.now(), cli);
    const events = (await listEvents(db, scope, { after: 0, limit: 50 })).filter((e) =>
      e.type.startsWith("approver"),
    );
    types = events.map((e) => e.type).filter((x) => x.startsWith("approver"));
    expect(types).toEqual(["approver.bootstrapped", "approvers.depleted"]);
    expect(JSON.parse(events[1]!.payload)).toEqual({ approver_id: id2 });
    // the event feed is what outbound webhooks fan out, so an endpoint can subscribe by type
    expect(EVENT_TYPES).toContain("approvers.depleted");
    expect(EVENT_TYPES).toContain("approver.bootstrapped");
  });

  test("the loss of the last approver is audited in the org's chain and the system chain", async () => {
    const r = await asInstance(input(generateEd25519().publicSpki));
    const id = (r as { output: { approver_id: string } }).output.approver_id;
    expect(
      await revokeApproverNotifying(db, { id: a.orgId, slug: "org-a" }, id, Date.now(), cli),
    ).toBe(true);
    for (const orgId of [a.orgId, await systemOrgId(db)]) {
      const row = (await listAudit(db, { orgId }, { limit: 50 })).find(
        (x) => x.op === "revoke_approver",
      );
      expect(row).toMatchObject({ principalKind: "cli", outcome: "ok" });
      expect(row!.input).toContain(id);
    }
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
