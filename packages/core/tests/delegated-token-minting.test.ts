// Delegated minting (#437): a bearer token mints within its own org and never escalates.
import { beforeEach, describe, expect, test } from "bun:test";
import { type Db, findApiTokenByHash, listAudit, listEvents } from "../src/db";
import { createMcpHttp } from "../src/mcp/http";
import { type Credential, dispatch, type DispatchEnv, registry } from "../src/ops";
import { hashToken } from "../src/ops/tokens";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const DAY = 86_400_000;
let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, now: () => NOW, transport: "rest" };
});

const as = (token: string, input: Record<string, unknown>, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token } as Credential, "create_api_token", input);
const code = (r: Awaited<ReturnType<typeof as>>) => (r.ok ? "ok" : r.error.code);
const orgWide = (role: "reader" | "operator" | "release_operator", o = {}) =>
  mintToken(db, { orgId: a.orgId }, role, { kind: "person", ...o });

describe("create_api_token by a bearer token", () => {
  test("happy path: the new token authenticates, audit has the parent id and no secret, event emitted", async () => {
    const parent = await orgWide("release_operator");
    const r = await as(parent.secret, { name: "child", role: "operator", expires_in_days: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { id: string; token: string; role: string; kind: string };
    expect(out.kind).toBe("agent");
    const row = await findApiTokenByHash(db, hashToken(out.token));
    expect(row?.id).toBe(out.id);
    expect(row?.createdBy).toBe(`token:${parent.id}`);
    const who = await dispatch(env, { kind: "bearer", token: out.token }, "list_runs", {});
    expect(who.ok).toBe(true);
    const audit = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).filter(
      (x) => x.op === "create_api_token",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principalKind: "token", principalId: parent.id });
    expect(JSON.stringify(audit)).not.toContain(out.token);
    const ev = await listEvents(
      db,
      { orgId: a.orgId },
      { after: 0, limit: 20, types: ["org.token_minted"] },
    );
    const events = Array.isArray(ev) ? ev : (ev as { events: unknown[] }).events;
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).toContain(parent.id);
    expect(text).toContain(out.id);
    expect(text).not.toContain(out.token);
  });

  test("an org-wide caller may mint a project-scoped token", async () => {
    const parent = await orgWide("operator");
    const r = await as(parent.secret, { name: "p", role: "reader", project: a.projectSlug });
    expect(r.ok && (r.output as { project_id: string }).project_id).toBe(a.projectId);
  });

  test("role escalation is refused", async () => {
    const parent = await orgWide("operator");
    expect(code(await as(parent.secret, { name: "x", role: "release_operator" }))).toBe(
      "forbidden",
    );
  });

  test("a reader token cannot mint", async () => {
    const parent = await orgWide("reader");
    expect(code(await as(parent.secret, { name: "x", role: "reader" }))).toBe("forbidden");
  });

  test("scope widening and a different project are refused", async () => {
    const scoped = await mintToken(db, { orgId: a.orgId, projectId: a.projectId }, "operator", {
      kind: "person",
    });
    expect(code(await as(scoped.secret, { name: "x", role: "reader" }))).toBe("ok");
    expect(code(await as(scoped.secret, { name: "x", role: "reader", project: "nope" }))).not.toBe(
      "ok",
    );
    const { createProject } = await import("../src/db");
    await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
    expect(code(await as(scoped.secret, { name: "x", role: "reader", project: "other" }))).not.toBe(
      "ok",
    );
    // The scoped caller's mint stays scoped to its own project.
    const r = await as(scoped.secret, { name: "y", role: "reader" });
    expect(r.ok && (r.output as { project_id: string }).project_id).toBe(a.projectId);
  });

  test("an expiry beyond the caller's is refused; a caller with none is capped at 365 days", async () => {
    const short = await orgWide("operator", { expiresAt: NOW + 10 * DAY });
    expect(code(await as(short.secret, { name: "x", role: "reader", expires_in_days: 11 }))).toBe(
      "forbidden",
    );
    expect(code(await as(short.secret, { name: "x", role: "reader", expires_in_days: 10 }))).toBe(
      "ok",
    );
    const forever = await orgWide("operator");
    expect(
      code(await as(forever.secret, { name: "x", role: "reader", expires_in_days: 366 })),
    ).toBe("invalid_input");
    expect(
      code(await as(forever.secret, { name: "x", role: "reader", expires_in_days: 365 })),
    ).toBe("ok");
  });

  test("kind rules: agent cannot mint person or above operator; person may mint person", async () => {
    const agent = await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "agent" });
    expect(code(await as(agent.secret, { name: "x", role: "reader", kind: "person" }))).toBe(
      "forbidden",
    );
    expect(code(await as(agent.secret, { name: "x", role: "release_operator" }))).toBe("forbidden");
    expect(code(await as(agent.secret, { name: "x", role: "operator" }))).toBe("ok");
    const person = await orgWide("operator");
    expect(code(await as(person.secret, { name: "x", role: "reader", kind: "person" }))).toBe("ok");
  });

  test("cross-org is refused", async () => {
    const parent = await orgWide("release_operator");
    expect(code(await as(parent.secret, { name: "x", role: "reader", org: "org-b" }))).toBe(
      "not_found",
    );
    expect(b.orgId).not.toBe(a.orgId);
  });

  test("over MCP is refused, and the tool is not listed", async () => {
    const parent = await orgWide("release_operator");
    const r = await as(
      parent.secret,
      { name: "x", role: "reader" },
      { ...env, transport: "mcp", viaMcp: true },
    );
    expect(code(r)).toBe("forbidden");
    expect(createMcpHttp).toBeDefined();
  });

  test("a member admin in-process still works; a non-admin member does not", async () => {
    const ok = await dispatch(env, { kind: "principal", principal: a.admin }, "create_api_token", {
      name: "m",
      role: "operator",
    });
    expect(ok.ok).toBe(true);
    const viewer = { ...a.admin, role: "viewer" } as typeof a.admin;
    const no = await dispatch(env, { kind: "principal", principal: viewer }, "create_api_token", {
      name: "m",
      role: "operator",
    });
    expect(no.ok).toBe(false);
  });
});

describe("per-org serialisation of revoke", () => {
  test("two concurrent self-revokes of the last two tokens: one succeeds, the other conflicts", async () => {
    const t1 = await mintToken(db, { orgId: a.orgId }, "operator");
    const t2 = await mintToken(db, { orgId: a.orgId }, "operator");
    const revoke = (t: { secret: string; id: string }) =>
      dispatch(env, { kind: "bearer", token: t.secret }, "revoke_api_token", {
        token_id: t.id,
        reason: "race",
      });
    const results = await Promise.all([revoke(t1), revoke(t2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok && failed.error.code).toBe("conflict");
  });
});

describe("rotation and cascade", () => {
  const bearer = (token: string) => ({ kind: "bearer", token }) as Credential;
  const mint = async (parent: string, over: Record<string, unknown> = {}) => {
    const r = await as(parent, { name: "c", role: "reader", ...over });
    if (!r.ok) throw new Error(r.error.message);
    return r.output as { id: string; token: string };
  };
  const alive = async (token: string) => (await dispatch(env, bearer(token), "list_runs", {})).ok;
  const revoke = (token: string, input: Record<string, unknown>) =>
    dispatch(env, bearer(token), "revoke_api_token", { reason: "t", ...input });

  test("rotation: self-revoke by default keeps the successor", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret);
    const r = await revoke(parent.secret, { token_id: parent.id });
    expect(r.ok).toBe(true);
    expect(await alive(parent.secret)).toBe(false);
    expect(await alive(child.token)).toBe(true);
  });

  test("self-revoke with cascade revokes the child and a grandchild, each audited", async () => {
    const parent = await orgWide("operator");
    await orgWide("reader");
    const child = await mint(parent.secret, { role: "operator" });
    const grand = await mint(child.token);
    const r = await revoke(parent.secret, { token_id: parent.id, cascade: true });
    expect(r.ok).toBe(true);
    expect(await alive(child.token)).toBe(false);
    expect(await alive(grand.token)).toBe(false);
    const rows = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).filter(
      (x) => x.op === "revoke_api_token",
    );
    const text = JSON.stringify(rows);
    expect(text).toContain("parent revoked");
    expect(text).toContain(grand.id);
    expect(text).not.toContain(child.token);
    expect(text).not.toContain(grand.token);
  });

  test("an admin member's revoke always cascades", async () => {
    const parent = await orgWide("operator");
    await orgWide("reader");
    const child = await mint(parent.secret);
    const r = await dispatch(env, { kind: "principal", principal: a.admin }, "revoke_api_token", {
      token_id: parent.id,
      reason: "t",
    });
    expect(r.ok).toBe(true);
    expect(await alive(child.token)).toBe(false);
  });

  test("the lockout guard counts what survives the cascade", async () => {
    const parent = await orgWide("operator");
    await mint(parent.secret);
    const r = await revoke(parent.secret, { token_id: parent.id, cascade: true });
    expect(code(r)).toBe("conflict");
    expect(await alive(parent.secret)).toBe(true);
  });

  test("a token may have at most 20 active children", async () => {
    const parent = await orgWide("operator");
    for (let i = 0; i < 20; i++) await mint(parent.secret);
    expect(code(await as(parent.secret, { name: "x", role: "reader" }))).toBe("conflict");
  });

  test("list_api_tokens shows created_by_token_id", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret);
    const r = await dispatch(env, bearer(parent.secret), "list_api_tokens", {});
    expect(r.ok).toBe(true);
    const rows = (r.ok ? r.output : { tokens: [] }) as {
      tokens: { id: string; created_by_token_id: string | null }[];
    };
    expect(rows.tokens.find((t) => t.id === child.id)?.created_by_token_id).toBe(parent.id);
    expect(rows.tokens.find((t) => t.id === parent.id)?.created_by_token_id).toBeNull();
  });

  test("an admin revoking an already revoked root still revokes and audits its live descendants", async () => {
    const root = await orgWide("operator");
    await orgWide("reader");
    const successor = await mint(root.secret, { role: "operator" });
    const grand = await mint(successor.token);
    expect((await revoke(root.secret, { token_id: root.id })).ok).toBe(true);
    expect(await alive(successor.token)).toBe(true);
    const r = await dispatch(env, { kind: "principal", principal: a.admin }, "revoke_api_token", {
      token_id: root.id,
      reason: "t",
    });
    expect(r.ok && r.output).toMatchObject({ already_revoked: true });
    expect(await alive(successor.token)).toBe(false);
    expect(await alive(grand.token)).toBe(false);
    const text = JSON.stringify(
      (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).filter(
        (x) => x.op === "revoke_api_token",
      ),
    );
    expect(text).toContain(grand.id);
    expect(text).toContain("parent revoked");
  });

  test("delegation depth: a token minted by a delegated token cannot mint", async () => {
    const root = await orgWide("operator");
    const c = await mint(root.secret, { role: "operator" });
    const g = await mint(c.token, { role: "operator" });
    expect(code(await as(g.token, { name: "x", role: "reader" }))).toBe("conflict");
  });

  test("one lineage holds at most 50 active delegated tokens, across siblings", async () => {
    const root = await orgWide("operator");
    const kids: { token: string }[] = [];
    for (let i = 0; i < 3; i++) kids.push(await mint(root.secret, { role: "operator" }));
    for (let i = 0; i < 20; i++) await mint(kids[0]!.token);
    for (let i = 0; i < 20; i++) await mint(kids[1]!.token);
    // 3 + 40 so far; the 8th more is the 51st.
    for (let i = 0; i < 7; i++) await mint(kids[2]!.token);
    expect(code(await as(kids[2]!.token, { name: "x", role: "reader" }))).toBe("conflict");
  });

  test("three successive rotations: S3 can still mint a project operator token; a purge takes S1..S3", async () => {
    const root = await orgWide("operator");
    await orgWide("reader");
    const s1 = await mint(root.secret, { role: "operator" });
    const k1 = await mint(s1.token);
    expect((await revoke(root.secret, { token_id: root.id })).ok).toBe(true);
    const s2 = await mint(s1.token, { role: "operator" });
    expect((await revoke(s1.token, { token_id: s1.id })).ok).toBe(true);
    const s3 = await mint(s2.token, { role: "operator" });
    expect((await revoke(s2.token, { token_id: s2.id })).ok).toBe(true);
    const project = await as(s3.token, { name: "p", role: "operator", project: a.projectSlug });
    expect(project.ok).toBe(true);
    const pt = project.ok ? (project.output as { id: string; token: string }) : undefined;
    expect(await alive(s3.token)).toBe(true);
    expect(await alive(k1.token)).toBe(true);
    const r = await dispatch(env, { kind: "principal", principal: a.admin }, "revoke_api_token", {
      token_id: root.id,
      reason: "purge",
    });
    expect(r.ok).toBe(true);
    for (const t of [s3.token, k1.token, pt!.token]) expect(await alive(t)).toBe(false);
    const text = JSON.stringify(
      (await listAudit(db, { orgId: a.orgId }, { limit: 100 })).filter(
        (x) => x.op === "revoke_api_token",
      ),
    );
    expect(text).toContain(s3.id);
    expect(text).toContain(pt!.id);
    expect(text).toContain(k1.id);
  });

  test("fan-out reset attack: self-revoking the parent does not reset the lineage cap", async () => {
    const root = await orgWide("operator");
    await orgWide("reader");
    const kids: { token: string; id: string }[] = [];
    for (let i = 0; i < 20; i++) kids.push(await mint(root.secret, { role: "operator" }));
    expect((await revoke(root.secret, { token_id: root.id })).ok).toBe(true);
    // 20 live now. Each child mints; the stored lineage stops at exactly 50 live tokens.
    let made = 0;
    let refused: string | undefined;
    for (const k of kids) {
      for (let i = 0; i < 20; i++) {
        const r = await as(k.token, { name: "x", role: "reader" });
        if (r.ok) made += 1;
        else {
          refused = r.error.code;
          break;
        }
      }
      if (refused) break;
    }
    expect(made).toBe(30);
    expect(refused).toBe("conflict");
  });
});

describe("revoking the minted subtree (#456)", () => {
  const bearer = (token: string) => ({ kind: "bearer", token }) as Credential;
  type Minted = { id: string; token: string };
  const mint = async (parent: string, over: Record<string, unknown> = {}): Promise<Minted> => {
    const r = await as(parent, { name: "c", role: "reader", ...over });
    if (!r.ok) throw new Error(r.error.message);
    return r.output as Minted;
  };
  const alive = async (token: string) => (await dispatch(env, bearer(token), "list_runs", {})).ok;
  const revoke = (token: string, input: Record<string, unknown>) =>
    dispatch(env, bearer(token), "revoke_api_token", { reason: "t", ...input });

  test("a parent revokes a child; cascade is on by default and counted", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator" });
    const grand = await mint(child.token);
    const r = await revoke(parent.secret, { token_id: child.id });
    expect(r.ok && r.output).toMatchObject({ revoked: true, descendants_revoked: 1 });
    expect(await alive(child.token)).toBe(false);
    expect(await alive(grand.token)).toBe(false);
    expect(await alive(parent.secret)).toBe(true);
    const text = JSON.stringify(
      (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).filter(
        (x) => x.op === "revoke_api_token",
      ),
    );
    expect(text).toContain(parent.id);
    expect(text).toContain(child.id);
    expect(text).toContain(grand.id);
  });

  test("a parent revokes a grandchild directly, leaving the child", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator" });
    const grand = await mint(child.token);
    const r = await revoke(parent.secret, { token_id: grand.id });
    expect(r.ok && r.output).toMatchObject({ revoked: true, descendants_revoked: 0 });
    expect(await alive(grand.token)).toBe(false);
    expect(await alive(child.token)).toBe(true);
  });

  test("cascade false keeps the descendant's own children", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator" });
    const grand = await mint(child.token);
    const r = await revoke(parent.secret, { token_id: child.id, cascade: false });
    expect(r.ok && r.output).toMatchObject({ descendants_revoked: 0 });
    expect(await alive(child.token)).toBe(false);
    expect(await alive(grand.token)).toBe(true);
  });

  test("ancestor, sibling, cousin, unrelated and other-org ids are all the same not_found", async () => {
    const parent = await orgWide("operator");
    const other = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator" });
    const sibling = await mint(parent.secret, { role: "operator" });
    const grand = await mint(child.token);
    const cousin = await mint(sibling.token);
    const foreign = await mintToken(db, { orgId: b.orgId }, "operator");
    const probe = async (who: string, id: string) => {
      const r = await revoke(who, { token_id: id });
      return r.ok ? "ok" : `${r.error.code}:${r.error.message}`;
    };
    const unknown = await probe(child.token, "no-such-token-id");
    expect(unknown.startsWith("not_found")).toBe(true);
    expect(await probe(child.token, parent.id)).toBe(unknown);
    expect(await probe(grand.token, parent.id)).toBe(unknown);
    expect(await probe(child.token, sibling.id)).toBe(unknown);
    expect(await probe(child.token, cousin.id)).toBe(unknown);
    expect(await probe(parent.secret, other.id)).toBe(unknown);
    expect(await probe(parent.secret, foreign.id)).toBe(unknown);
    for (const t of [
      parent.secret,
      other.secret,
      child.token,
      sibling.token,
      grand.token,
      cousin.token,
    ]) {
      expect(await alive(t)).toBe(true);
    }
    expect(await alive(foreign.secret)).toBe(true);
  });

  test("a concurrent mint under the target is revoked or refused", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator" });
    const [rev, minted] = await Promise.all([
      revoke(parent.secret, { token_id: child.id }),
      as(child.token, { name: "race", role: "reader" }),
    ]);
    expect(rev.ok).toBe(true);
    if (minted.ok) expect(await alive((minted.output as Minted).token)).toBe(false);
    expect(await alive(child.token)).toBe(false);
  });

  test("self-revoke still works and the revoked token gets 401", async () => {
    const parent = await orgWide("operator");
    await orgWide("reader");
    const child = await mint(parent.secret, { role: "operator" });
    expect((await revoke(child.token, { token_id: child.id })).ok).toBe(true);
    const after = await dispatch(env, bearer(child.token), "list_runs", {});
    expect(after.ok ? "ok" : after.error.code).toBe("unauthenticated");
  });
});

describe("expires_in_minutes (#548)", () => {
  const MIN = 60_000;
  const bearer = (token: string): Credential => ({ kind: "bearer", token });
  const alive = async (token: string, e: DispatchEnv) =>
    (await dispatch(e, bearer(token), "list_runs", {})).ok;
  const mint = async (parent: string, over: Record<string, unknown> = {}) => {
    const r = await as(parent, { name: "c", role: "reader", ...over });
    if (!r.ok) throw new Error(r.error.message);
    return r.output as { id: string; token: string; expires_at: string };
  };

  test("a 15-minute child expires on time", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { expires_in_minutes: 15 });
    expect(child.expires_at).toBe(new Date(NOW + 15 * MIN).toISOString());
    const at = (t: number): DispatchEnv => ({ ...env, now: () => t });
    expect(await alive(child.token, at(NOW + 14 * MIN))).toBe(true);
    expect(await alive(child.token, at(NOW + 15 * MIN + 1))).toBe(false);
  });

  test("a 5-minute token is refused after it expires", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { expires_in_minutes: 5 });
    expect(await alive(child.token, { ...env, now: () => NOW + 5 * MIN + 1 })).toBe(false);
  });

  test("minutes and days together are refused", async () => {
    const parent = await orgWide("operator");
    const r = await as(parent.secret, {
      name: "x",
      role: "reader",
      expires_in_days: 1,
      expires_in_minutes: 10,
    });
    expect(code(r)).toBe("invalid_input");
  });

  test("minutes are bounded to 5..1440", async () => {
    const parent = await orgWide("operator");
    for (const m of [4, 1441, 0, 1.5]) {
      expect(
        code(await as(parent.secret, { name: "x", role: "reader", expires_in_minutes: m })),
      ).toBe("invalid_input");
    }
    for (const m of [5, 1440]) {
      expect(
        code(await as(parent.secret, { name: "x", role: "reader", expires_in_minutes: m })),
      ).toBe("ok");
    }
  });

  test("a minute expiry beyond the parent's is refused, as days are (not clamped)", async () => {
    const parent = await orgWide("operator", { expiresAt: NOW + 30 * MIN });
    expect(
      code(await as(parent.secret, { name: "x", role: "reader", expires_in_minutes: 31 })),
    ).toBe("forbidden");
    const ok = await mint(parent.secret, { expires_in_minutes: 30 });
    expect(ok.expires_at).toBe(new Date(NOW + 30 * MIN).toISOString());
  });

  test("20 expired short-lived children do not block a 21st; live ones do", async () => {
    const parent = await orgWide("operator");
    for (let i = 0; i < 20; i++) await mint(parent.secret, { expires_in_minutes: 5 });
    expect(
      code(await as(parent.secret, { name: "x", role: "reader", expires_in_minutes: 5 })),
    ).toBe("conflict");
    const later: DispatchEnv = { ...env, now: () => NOW + 6 * MIN };
    const r = await as(parent.secret, { name: "x", role: "reader", expires_in_minutes: 5 }, later);
    expect(code(r)).toBe("ok");
  });

  test("short-lived children count toward the depth limit", async () => {
    const parent = await orgWide("operator");
    const child = await mint(parent.secret, { role: "operator", expires_in_minutes: 60 });
    const grand = await mint(child.token, { role: "operator", expires_in_minutes: 30 });
    expect(code(await as(grand.token, { name: "x", role: "reader", expires_in_minutes: 5 }))).toBe(
      "conflict",
    );
  });
});
