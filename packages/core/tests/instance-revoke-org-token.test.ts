// instance_revoke_org_token (#438): the instance administrator's break-glass revoke of a leaked
// tenant token, cascading to everything it minted, audited in both chains, REST only.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  createOrg,
  type Db,
  getApiToken,
  insertApiToken,
  listAudit,
  listEvents,
  openDatabase,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import {
  dispatch,
  type DispatchEnv,
  generateToken,
  hashToken,
  registry,
  type Credential,
  type Principal,
} from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { mintToken } from "./ops-helpers";

let db: Db;
let env: DispatchEnv;
let secret: string;
let a: { orgId: string };
let b: { orgId: string };

const REASON = "leaked in a public gist";

async function mintChild(orgId: string, parentId: string) {
  const s = generateToken();
  const row = await insertApiToken(
    db,
    { orgId },
    {
      name: "child",
      role: "operator",
      tokenHash: hashToken(s),
      createdBy: `token:${parentId}`,
      expiresAt: Date.now() + 3_600_000,
    },
  );
  return { secret: s, id: row.id };
}

const revoke = (orgSlug: string, tokenId: string, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_revoke_org_token", {
    target_org: orgSlug,
    token_id: tokenId,
    reason: REASON,
  });

// A read through the org's own token: 401 once revoked.
const whoami = (token: string) => dispatch(env, { kind: "bearer", token }, "list_api_tokens", {});

beforeEach(async () => {
  db = openDatabase(":memory:");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  a = { orgId: (await createOrg(db, { slug: "org-a", name: "a" })).id };
  b = { orgId: (await createOrg(db, { slug: "org-b", name: "b" })).id };
});

describe("instance_revoke_org_token", () => {
  test("revokes at once: the token then gets 401, and the output says so", async () => {
    const keep = await mintToken(db, { orgId: a.orgId }, "release_operator", { name: "keeper" });
    const leaked = await mintToken(db, { orgId: a.orgId }, "operator", { name: "leaked" });
    expect((await whoami(leaked.secret)).ok).toBe(true);
    const r = await revoke("org-a", leaked.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toEqual({
      token_id: leaked.id,
      org: "org-a",
      revoked: true,
      already_revoked: false,
      descendants_revoked: 0,
      org_locked_out: false,
    });
    const after = await whoami(leaked.secret);
    expect(!after.ok && after.error.code).toBe("unauthenticated");
    expect((await whoami(keep.secret)).ok).toBe(true);
  });

  test("a token the revoked one minted is revoked too, and counted", async () => {
    const root = await mintToken(db, { orgId: a.orgId }, "release_operator");
    const child = await mintChild(a.orgId, root.id);
    const grandchild = await mintChild(a.orgId, child.id);
    const r = await revoke("org-a", root.id);
    expect(r.ok && r.output).toMatchObject({ descendants_revoked: 2, org_locked_out: true });
    for (const t of [root, child, grandchild]) {
      const out = await whoami(t.secret);
      expect(!out.ok && out.error.code).toBe("unauthenticated");
      expect((await getApiToken(db, { orgId: a.orgId }, t.id))?.revokedAt).not.toBeNull();
    }
  });

  test("both audit chains and the org feed carry it, never the secret or hash", async () => {
    const root = await mintToken(db, { orgId: a.orgId }, "operator");
    await mintChild(a.orgId, root.id);
    await mintToken(db, { orgId: a.orgId }, "release_operator");
    await revoke("org-a", root.id);
    const orgRows = await listAudit(db, { orgId: a.orgId }, { limit: 50 });
    const own = orgRows.find((x) => x.op === "instance_revoke_org_token")!;
    expect(JSON.parse(own.input)).toMatchObject({
      target_org: "org-a",
      token_id: root.id,
      reason: REASON,
      descendants_revoked: 1,
    });
    const sysRows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const sys = sysRows.filter((x) => x.op === "org_token_revoked");
    expect(sys.length).toBe(1);
    expect(JSON.parse(sys[0]!.input)).toMatchObject({ token_id: root.id, descendants_revoked: 1 });
    expect(sysRows.some((x) => x.op === "instance_revoke_org_token")).toBe(true);
    const blob = JSON.stringify([...orgRows, ...sysRows]);
    expect(blob).not.toContain(root.secret);
    expect(blob).not.toContain(hashToken(root.secret));
    const events = await listEvents(
      db,
      { orgId: a.orgId },
      { after: 0, limit: 20, types: ["org.token_revoked"] },
    );
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      token_id: root.id,
      reason: REASON,
      descendants_revoked: 1,
    });
  });

  test("an unknown id, another org's id and an unknown org are the same not_found", async () => {
    const other = await mintToken(db, { orgId: b.orgId }, "operator");
    await mintToken(db, { orgId: a.orgId }, "operator");
    const outs = [
      await revoke("org-a", "01HZZZZZZZZZZZZZZZZZZZZZZZ"),
      await revoke("org-a", other.id),
      await revoke("no-such-org", other.id),
    ];
    const shapes = outs.map((o) => (!o.ok ? [o.error.code, o.error.message] : null));
    expect(shapes[0]![0]).toBe("not_found");
    expect(shapes[1]).toEqual(shapes[0]!);
    expect(shapes[2]).toEqual(shapes[0]!);
    // Org B's token is untouched.
    expect((await getApiToken(db, { orgId: b.orgId }, other.id))?.revokedAt).toBeNull();
  });

  test("already revoked: idempotent success that says so, with no second event", async () => {
    const t = await mintToken(db, { orgId: a.orgId }, "operator");
    await revoke("org-a", t.id);
    const again = await revoke("org-a", t.id);
    expect(again.ok && again.output).toMatchObject({
      revoked: true,
      already_revoked: true,
      descendants_revoked: 0,
    });
    const events = await listEvents(
      db,
      { orgId: a.orgId },
      { after: 0, limit: 20, types: ["org.token_revoked"] },
    );
    expect(events.length).toBe(1);
  });

  test("org tokens of every role, members and MCP are refused", async () => {
    const victim = await mintToken(db, { orgId: a.orgId }, "operator");
    for (const orgId of [a.orgId, b.orgId]) {
      const creds: Credential[] = [];
      for (const role of AGENT_ROLES) {
        creds.push({ kind: "bearer", token: (await mintToken(db, { orgId }, role)).secret });
      }
      const owner: Principal = { kind: "member", id: `o-${orgId}`, orgId, role: "owner" };
      creds.push({ kind: "principal", principal: owner });
      for (const cred of creds) {
        const r = await dispatch(env, cred, "instance_revoke_org_token", {
          target_org: "org-a",
          token_id: victim.id,
          reason: REASON,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    expect((await getApiToken(db, { orgId: a.orgId }, victim.id))?.revokedAt).toBeNull();
    const op = registry.ops.find((o) => o.name === "instance_revoke_org_token")!;
    expect(op.mcp).toBe(false);
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_revoke_org_token");
    // No instance credential on the adapter: not a credential at all.
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_revoke_org_token",
      { target_org: "org-a", token_id: victim.id, reason: REASON },
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });

  test("the reason is required and bounded", async () => {
    const t = await mintToken(db, { orgId: a.orgId }, "operator");
    for (const reason of [undefined, "", "x".repeat(501)]) {
      const r = await dispatch(
        env,
        { kind: "bearer", token: secret },
        "instance_revoke_org_token",
        { target_org: "org-a", token_id: t.id, ...(reason === undefined ? {} : { reason }) },
      );
      expect(!r.ok && r.error.code).toBe("invalid_input");
    }
  });
});
