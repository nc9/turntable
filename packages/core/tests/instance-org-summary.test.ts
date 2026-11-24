// instance_org_summary (#469): per-org identity counts for the instance administrator, counts
// only, audited as a read in the system chain; plus the approver re-enrol doctor warning.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { systemOrgId } from "../src/audit/failures";
import {
  addMember,
  createMemberInvite,
  createOrg,
  createUser,
  type Db,
  insertApprover,
  listAudit,
  openDatabase,
  revokeApprover,
} from "../src/db";
import { AGENT_ROLES, type MemberRole } from "../src/db/schema";
import { checkApproverReenrol } from "../src/doctor/checks";
import { readerOf } from "../src/doctor/real";
import type { DoctorInputs } from "../src/doctor/types";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, rawExec } from "./ops-helpers";

type Row = {
  org: string;
  tokens: { active: number; expiring_within_7_days: number };
  approvers: { active: number; revoked: number; active_missing_github_user_id: number };
  members: { owner: number; admin: number; member: number; viewer: number };
  pending_invites: number;
};
type Out = {
  orgs: Row[];
  totals: {
    orgs: number;
    active_tokens: number;
    active_approvers: number;
    active_approvers_missing_github_user_id: number;
    members: number;
    pending_invites: number;
  };
};

const DAY = 86_400_000;
const LEAKS = {
  tokenName: "leaky-token-name",
  login: "leaky-login",
  person: "Leaky Person",
  ghId: "9876543210",
  key: "leaky-public-key-material",
  display: "Leaky Display",
};

let db: Db;
let env: DispatchEnv;
let secret: string;
let a: string;
let b: string;
let now: number;

const exec = (q: ReturnType<typeof sql>) => db.run((h) => rawExec(h.orm, q));

async function member(orgId: string, role: MemberRole, name: string) {
  const u = await createUser(db, { displayName: name });
  await addMember(db, { orgId }, { userId: u.id, role });
}

async function approver(orgId: string, n: number, githubUserId: string | null) {
  return insertApprover(
    db,
    orgId,
    {
      person: `${LEAKS.person} ${n}`,
      forgeLogin: `${LEAKS.login}-${n}`,
      githubUserId,
      kind: "ed25519",
      publicKey: `${LEAKS.key}-${orgId}-${n}`,
      alg: "EdDSA",
      createdBy: "test:setup",
    },
    now,
  );
}

async function invite(orgId: string, ghId: string, expiresAt: number) {
  return (await createMemberInvite(
    db,
    { orgId },
    {
      githubLogin: `${LEAKS.login}-inv-${ghId}`,
      githubUserId: ghId,
      role: "member",
      createdBy: "test:setup",
      now,
      expiresAt,
      canReplace: () => true,
    },
  ))!;
}

beforeEach(async () => {
  now = Date.now();
  db = openDatabase(":memory:");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  a = (await createOrg(db, { slug: "org-a", name: "org-a" })).id;
  b = (await createOrg(db, { slug: "org-b", name: "org-b" })).id;
});

const call = (e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_org_summary", {});

async function seed() {
  // org-a: 3 live tokens (one never expires, one in 2 days, one in 30 days), 1 revoked, 1 expired.
  await mintToken(db, { orgId: a }, "operator", { name: LEAKS.tokenName });
  await mintToken(db, { orgId: a }, "reader", { expiresAt: now + 2 * DAY });
  await mintToken(db, { orgId: a }, "reader", { expiresAt: now + 30 * DAY });
  const gone = await mintToken(db, { orgId: a }, "reader");
  await exec(sql`UPDATE api_tokens SET revoked_at = ${now - 1000} WHERE id = ${gone.id}`);
  await mintToken(db, { orgId: a }, "reader", { expiresAt: now - DAY });
  // org-b: 1 live token expiring in 6 days.
  await mintToken(db, { orgId: b }, "reader", { expiresAt: now + 6 * DAY });
  // approvers: org-a has two with ids, one without, one revoked without; org-b one without.
  await approver(a, 1, LEAKS.ghId);
  await approver(a, 2, "1111");
  await approver(a, 3, null);
  const rev = await approver(a, 4, null);
  await revokeApprover(db, a, rev.id, now);
  await approver(b, 1, null);
  // members
  await member(a, "owner", LEAKS.display);
  await member(a, "admin", "x1");
  await member(a, "member", "x2");
  await member(a, "member", "x3");
  await member(b, "viewer", "x4");
  // invites: org-a one pending, one consumed, one expired, one revoked; org-b one pending.
  await invite(a, "1001", now + DAY);
  const used = await invite(a, "1002", now + DAY);
  await exec(sql`UPDATE member_invites SET used_at = ${now} WHERE id = ${used.id}`);
  await invite(a, "1003", now - DAY);
  const rv = await invite(a, "1004", now + DAY);
  await exec(sql`UPDATE member_invites SET revoked_at = ${now} WHERE id = ${rv.id}`);
  await invite(b, "2001", now + DAY);
}

describe("instance_org_summary", () => {
  test("counts are correct across two orgs", async () => {
    await seed();
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as Out;
    expect(out.orgs.map((o) => o.org).toSorted()).toEqual(["org-a", "org-b"]);
    const oa = out.orgs.find((o) => o.org === "org-a")!;
    const ob = out.orgs.find((o) => o.org === "org-b")!;
    expect(oa).toEqual({
      org: "org-a",
      tokens: { active: 3, expiring_within_7_days: 1 },
      approvers: { active: 3, revoked: 1, active_missing_github_user_id: 1 },
      members: { owner: 1, admin: 1, member: 2, viewer: 0 },
      pending_invites: 1,
    });
    expect(ob).toEqual({
      org: "org-b",
      tokens: { active: 1, expiring_within_7_days: 1 },
      approvers: { active: 1, revoked: 0, active_missing_github_user_id: 1 },
      members: { owner: 0, admin: 0, member: 0, viewer: 1 },
      pending_invites: 1,
    });
    expect(out.totals).toEqual({
      orgs: 2,
      active_tokens: 4,
      active_approvers: 4,
      active_approvers_missing_github_user_id: 2,
      members: 5,
      pending_invites: 2,
    });
  });

  test("an org with nothing reports zeros", async () => {
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const oa = (r.output as Out).orgs.find((o) => o.org === "org-a")!;
    expect(oa.tokens).toEqual({ active: 0, expiring_within_7_days: 0 });
    expect(oa.pending_invites).toBe(0);
  });

  test("the output carries no ids, logins, names or key material", async () => {
    await seed();
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = JSON.stringify(r.output);
    for (const leak of [...Object.values(LEAKS), "ops laptop", "1111", "1001", "2001", a, b]) {
      expect(text).not.toContain(leak);
    }
    expect(text).not.toContain("tt_");
    expect(Object.keys(r.output as object).toSorted()).toEqual(["orgs", "totals"]);
    expect(r.untrusted).toBe(false);
  });

  test("is audited as a read in the system chain", async () => {
    await call();
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const mine = rows.filter((x) => x.op === "instance_org_summary");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.effect === "read")).toBe(true);
  });

  test("org tokens of every role, members and MCP are refused", async () => {
    for (const orgId of [a, b]) {
      const creds: Credential[] = [];
      for (const role of AGENT_ROLES) {
        creds.push({ kind: "bearer", token: (await mintToken(db, { orgId }, role)).secret });
      }
      const owner: Principal = { kind: "member", id: `o-${orgId}`, orgId, role: "owner" };
      creds.push({ kind: "principal", principal: owner });
      for (const cred of creds) {
        const r = await dispatch(env, cred, "instance_org_summary", {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    const op = registry.ops.find((o) => o.name === "instance_org_summary")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_org_summary");
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_org_summary",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });
});

describe("doctor approver_github_ids", () => {
  const inputs = () => ({ db: readerOf(db) }) as unknown as DoctorInputs;

  test("passes with none, or when every active key has an id", async () => {
    expect(await checkApproverReenrol(inputs())).toMatchObject({ status: "pass" });
    await approver(a, 1, "1111");
    expect(await checkApproverReenrol(inputs())).toMatchObject({ status: "pass" });
  });

  test("a revoked key without an id does not warn", async () => {
    const r = await approver(a, 1, null);
    await revokeApprover(db, a, r.id, now);
    expect(await checkApproverReenrol(inputs())).toMatchObject({ status: "pass" });
  });

  test("warns with a count, naming no org or key, when an active key lacks an id", async () => {
    await approver(a, 1, null);
    await approver(b, 2, null);
    await approver(b, 3, "1111");
    const c = await checkApproverReenrol(inputs());
    expect(c.status).toBe("warn");
    expect(c.summary).toBe("2 approver keys need re-enrolling for passkey step-up");
    expect(c.fix).toContain("re-enrol");
    const text = JSON.stringify(c);
    for (const leak of ["org-a", "org-b", LEAKS.login, LEAKS.key, LEAKS.person]) {
      expect(text).not.toContain(leak);
    }
  });
});
