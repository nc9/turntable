// list_api_tokens and revoke_api_token (#435): the org's tokens through the operations registry,
// so a tenant can rotate a credential on a server with no CLI. Runs on both dialects
// (TURNTABLE_TEST_DB).
import { beforeEach, describe, expect, test } from "bun:test";
import { listAudit, type Db } from "../src/db";
import { dispatch, type Principal, registry } from "../src/ops";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
const env = () => ({ registry, db, now: () => Date.now() });

const asBearer = (token: string) => ({ kind: "bearer" as const, token });
const asMember = (p: Principal) => ({ kind: "principal" as const, principal: p });

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
});

const revoke = (cred: Parameters<typeof dispatch>[1], input: Record<string, unknown>) =>
  dispatch(env(), cred, "revoke_api_token", { reason: "rotation", ...input });

const code = (r: Awaited<ReturnType<typeof revoke>>): string => (r.ok ? "ok" : r.error.code);

describe("revoke_api_token", () => {
  test("an owner revokes another token, which then gets 401", async () => {
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    const keep = await mintToken(db, { orgId: a.orgId }, "reader");
    const victim = await mintToken(db, { orgId: a.orgId }, "operator");
    const before = await dispatch(env(), asBearer(victim.secret), "list_runs", {});
    expect(before.ok).toBe(true);
    const r = await revoke(asMember(owner), { token_id: victim.id });
    expect(r.ok && r.output).toMatchObject({ revoked: true, already_revoked: false });
    const after = await dispatch(env(), asBearer(victim.secret), "list_runs", {});
    expect(after.ok ? "ok" : after.error.code).toBe("unauthenticated");
    expect((await dispatch(env(), asBearer(keep.secret), "list_runs", {})).ok).toBe(true);
  });

  test("a non-owner may not revoke someone else's token", async () => {
    const other = await mintToken(db, { orgId: a.orgId }, "reader");
    const op = await mintToken(db, { orgId: a.orgId }, "release_operator");
    expect(code(await revoke(asBearer(op.secret), { token_id: other.id }))).toBe("forbidden");
    const viewer: Principal = { kind: "member", id: "v", orgId: a.orgId, role: "member" };
    expect(code(await revoke(asMember(viewer), { token_id: other.id }))).toBe("forbidden");
    expect((await dispatch(env(), asBearer(other.secret), "list_runs", {})).ok).toBe(true);
  });

  test("a token revokes itself", async () => {
    await mintToken(db, { orgId: a.orgId }, "operator");
    const me = await mintToken(db, { orgId: a.orgId }, "reader");
    const r = await revoke(asBearer(me.secret), { token_id: me.id });
    expect(r.ok && r.output).toMatchObject({ revoked: true, org_locked_out: false });
    expect((await dispatch(env(), asBearer(me.secret), "list_runs", {})).ok).toBe(false);
  });

  test("the last usable token needs confirm_lockout, and only by itself", async () => {
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    const only = await mintToken(db, { orgId: a.orgId }, "operator");
    // An expired token does not count as usable.
    await mintToken(db, { orgId: a.orgId }, "reader", { expiresAt: 1 });
    expect(code(await revoke(asMember(owner), { token_id: only.id }))).toBe("conflict");
    // Even confirmed, an owner may not lock the org out: only the token itself may.
    expect(code(await revoke(asMember(owner), { token_id: only.id, confirm_lockout: true }))).toBe(
      "conflict",
    );
    expect(code(await revoke(asBearer(only.secret), { token_id: only.id }))).toBe("conflict");
    const r = await revoke(asBearer(only.secret), { token_id: only.id, confirm_lockout: true });
    expect(r.ok && r.output).toMatchObject({ revoked: true, org_locked_out: true });
    const ops = (await listAudit(db, { orgId: a.orgId })).map((e) => e.op);
    expect(ops).toContain("org_tokens_exhausted");
    expect((await dispatch(env(), asBearer(only.secret), "list_runs", {})).ok).toBe(false);
  });

  test("another org's token id is not_found, and nothing changes", async () => {
    const mine = await mintToken(db, { orgId: a.orgId }, "operator");
    const theirs = await mintToken(db, { orgId: b.orgId }, "operator");
    expect(code(await revoke(asBearer(mine.secret), { token_id: theirs.id }))).toBe("not_found");
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    expect(code(await revoke(asMember(owner), { token_id: theirs.id }))).toBe("not_found");
    expect(code(await revoke(asMember(owner), { token_id: "nope" }))).toBe("not_found");
    expect((await dispatch(env(), asBearer(theirs.secret), "list_runs", {})).ok).toBe(true);
  });

  test("revoking twice is a no-op that reports already_revoked", async () => {
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    await mintToken(db, { orgId: a.orgId }, "reader");
    const v = await mintToken(db, { orgId: a.orgId }, "operator");
    const first = await revoke(asMember(owner), { token_id: v.id });
    const second = await revoke(asMember(owner), { token_id: v.id });
    expect(first.ok && first.output).toMatchObject({ already_revoked: false });
    expect(second.ok && second.output).toMatchObject({ revoked: true, already_revoked: true });
    const revokeRows = (await listAudit(db, { orgId: a.orgId })).filter(
      (e) => e.op === "revoke_api_token",
    );
    // Each call is audited as a call; neither adds a lockout entry.
    expect(revokeRows.length).toBe(2);
    expect(
      (await listAudit(db, { orgId: a.orgId })).some((e) => e.op === "org_tokens_exhausted"),
    ).toBe(false);
  });

  test("the audit entry carries the token id and reason, never a secret", async () => {
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    await mintToken(db, { orgId: a.orgId }, "reader");
    const v = await mintToken(db, { orgId: a.orgId }, "operator");
    await revoke(asMember(owner), { token_id: v.id, reason: "leaked in a log" });
    const text = JSON.stringify(await listAudit(db, { orgId: a.orgId }));
    expect(text).toContain(v.id);
    expect(text).toContain("leaked in a log");
    expect(text).not.toContain(v.secret);
  });
});

describe("list_api_tokens", () => {
  test("lists the org's tokens with status, never a secret or hash", async () => {
    const reader = await mintToken(db, { orgId: a.orgId }, "reader", { name: "r" });
    const gone = await mintToken(db, { orgId: a.orgId }, "operator", { name: "g" });
    await mintToken(db, { orgId: a.orgId }, "operator", { name: "old", expiresAt: 1 });
    const other = await mintToken(db, { orgId: b.orgId }, "reader", { name: "other-org" });
    const owner: Principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" };
    await revoke(asMember(owner), { token_id: gone.id });
    const res = await dispatch(env(), asBearer(reader.secret), "list_api_tokens", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const tokens = (res.output as { tokens: { id: string; name: string; status: string }[] })
      .tokens;
    expect(tokens.map((t) => [t.name, t.status]).sort()).toEqual([
      ["g", "revoked"],
      ["old", "expired"],
      ["r", "active"],
    ]);
    const text = JSON.stringify(res.output);
    for (const s of [reader.secret, gone.secret, other.secret, "token_hash", "tokenHash"]) {
      expect(text).not.toContain(s);
    }
    expect(text).not.toContain(other.id);
    // No 64-hex sha256 anywhere.
    expect(/[0-9a-f]{64}/.test(text)).toBe(false);
  });
});

describe("list_api_tokens paging", () => {
  test("cursor pages cover every token once", async () => {
    const reader = await mintToken(db, { orgId: a.orgId }, "reader");
    for (let i = 0; i < 4; i++) await mintToken(db, { orgId: a.orgId }, "reader");
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await dispatch(env(), asBearer(reader.secret), "list_api_tokens", {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      if (!res.ok) throw new Error(res.error.code);
      const out = res.output as { tokens: { id: string }[]; next_cursor: string | null };
      seen.push(...out.tokens.map((t) => t.id));
      if (out.next_cursor === null) break;
      cursor = out.next_cursor;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });
});
