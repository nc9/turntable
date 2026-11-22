import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, listAudit } from "../src/db";
import { schema } from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, hashToken, registry } from "../src/ops";
import { createTokenFromCli, listTokensFromCli, revokeTokenFromCli } from "../src/ops/token-cli";
import { assertMintable } from "../src/ops/tokens";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

const opts = { org: "org-a", role: "reader", name: "ci-bot", now: () => NOW };

test("token create mints a working token and stores only its hash", async () => {
  const t = await createTokenFromCli(db, opts);
  expect(t).toMatchObject({ role: "reader", org: "org-a", project: null });
  expect(t.expiresAt).toBe(NOW + 90 * 86_400_000);

  const rows = await db.orm.select().from(schema.apiTokens);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    tokenHash: hashToken(t.secret),
    createdBy: "cli:local",
    projectId: null,
  });
  expect(JSON.stringify(rows)).not.toContain(t.secret);

  const res = await dispatch(
    { registry, db, now: () => NOW },
    { kind: "bearer", token: t.secret },
    "list_runs",
    {},
  );
  expect(res.ok).toBe(true);
  const audit = await listAudit(db, { orgId: a.orgId });
  expect(audit.map((r) => [r.principalKind, r.op, r.outcome])).toEqual([
    ["cli", "create_api_token", "ok"],
  ]);
  expect(audit[0]!.input).not.toContain(t.secret);
});

test("project-scoped token is pinned, operator can cancel, reader cannot", async () => {
  const pinned = await createTokenFromCli(db, { ...opts, role: "operator", project: "app" });
  const row = (await db.orm.select().from(schema.apiTokens))[0]!;
  expect(row.projectId).toBe(a.projectId);
  const env = { registry, db, now: () => NOW };
  const cancel = await dispatch(env, { kind: "bearer", token: pinned.secret }, "cancel", {
    run_id: a.runId,
  });
  expect(cancel.ok).toBe(true);
  const reader = await createTokenFromCli(db, { ...opts, project: "app", name: "r" });
  const denied = await dispatch(env, { kind: "bearer", token: reader.secret }, "cancel", {
    run_id: a.runId,
  });
  expect(!denied.ok && denied.error.code).toBe("forbidden");
});

test("bad input is refused before anything is written", async () => {
  const cases: [Partial<typeof opts> & Record<string, unknown>, RegExp][] = [
    [{ role: "admin" }, /unknown role/],
    [{ org: "nope" }, /no org/],
    [{ project: "nope" }, /no project/],
    [{ name: "  " }, /--name/],
    [{ expiresInDays: 0 }, /expires-days/],
    [{ expiresInDays: 400 }, /expires-days/],
  ];
  for (const [patch, message] of cases) {
    await expect(createTokenFromCli(db, { ...opts, ...patch } as never)).rejects.toThrow(message);
  }
  expect(await db.orm.select().from(schema.apiTokens)).toHaveLength(0);
});

test("the CLI binary prints only the secret on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longshore-cli-"));
  try {
    const { openDatabase, createOrg } = await import("../src/db");
    const cliDb = openDatabase(join(dir, "longshore.db"));
    await createOrg(cliDb, { slug: "acme", name: "Acme" });
    cliDb.close();
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "../src/main.ts"),
        "token",
        "create",
        "--org",
        "acme",
        "--role",
        "reader",
        "--name",
        "bot",
        "--data-dir",
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^tt_[A-Za-z0-9_-]{43}$/);
    expect(err).toContain("shown once");
    expect(err).not.toContain(out.trim());
    const bad = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "../src/main.ts"),
        "token",
        "create",
        "--org",
        "acme",
        "--role",
        "admin",
        "--name",
        "x",
        "--data-dir",
        dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await bad.exited).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a token can never mint a token exceeding its own scope", () => {
  const orgWide = {
    kind: "token",
    id: "t",
    orgId: "o",
    projectId: null,
    role: "operator",
  } as const;
  const pinned = { ...orgWide, projectId: "p1" } as const;
  // role: never higher than its own
  for (const role of AGENT_ROLES) {
    const ok = role === "reader" || role === "operator";
    const run = () => assertMintable(orgWide, { role, projectId: undefined });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(/higher role/);
  }
  // scope: an org-wide token from a pinned one, or another project, is refused
  expect(() => assertMintable(pinned, { role: "reader", projectId: undefined })).toThrow(/wider/);
  expect(() => assertMintable(pinned, { role: "reader", projectId: "p2" })).toThrow(/wider/);
  expect(() => assertMintable(pinned, { role: "reader", projectId: "p1" })).not.toThrow();
  // an org-wide token may narrow to a project
  expect(() => assertMintable(orgWide, { role: "reader", projectId: "p9" })).not.toThrow();
  // people are the trust root
  const admin = { kind: "member", id: "u", orgId: "o", role: "admin" } as const;
  expect(() =>
    assertMintable(admin, { role: "release_operator", projectId: undefined }),
  ).not.toThrow();
});

test("token list shows status without secrets, and filters by project", async () => {
  const env = { registry, db, now: () => NOW };
  const live = await createTokenFromCli(db, {
    ...opts,
    name: "live",
    project: "app",
    role: "operator",
  });
  const old = await createTokenFromCli(db, {
    ...opts,
    name: "old",
    expiresInDays: 1,
    now: () => NOW - 3 * 86_400_000,
  });
  const gone = await createTokenFromCli(db, { ...opts, name: "gone" });
  await revokeTokenFromCli(db, gone.id, () => NOW);
  await dispatch(env, { kind: "bearer", token: live.secret }, "list_runs", {});

  const all = await listTokensFromCli(db, { org: "org-a", now: () => NOW });
  expect(Object.fromEntries(all.map((t) => [t.name, t.status]))).toEqual({
    live: "active",
    old: "expired",
    gone: "revoked",
  });
  expect(all.find((t) => t.name === "live")).toMatchObject({
    project: "app",
    role: "operator",
    lastUsedAt: NOW,
  });
  expect(all.find((t) => t.name === "old")!.project).toBeNull();
  const text = JSON.stringify(all);
  for (const s of [live.secret, old.secret, gone.secret]) expect(text).not.toContain(s);
  expect(text).not.toContain(hashToken(live.secret));
  const pinned = await listTokensFromCli(db, { org: "org-a", project: "app", now: () => NOW });
  expect(pinned.map((t) => t.name)).toEqual(["live"]);
  await expect(listTokensFromCli(db, { org: "nope" })).rejects.toThrow(/no org/);
  await expect(listTokensFromCli(db, { org: "org-a", project: "nope" })).rejects.toThrow(
    /no project/,
  );
});

test("token revoke cuts access at once, is audited, and refuses unknown or repeated ids", async () => {
  const env = { registry, db, now: () => NOW };
  const t = await createTokenFromCli(db, opts);
  expect((await dispatch(env, { kind: "bearer", token: t.secret }, "list_runs", {})).ok).toBe(true);
  const done = await revokeTokenFromCli(db, t.id, () => NOW);
  expect(done).toMatchObject({ id: t.id, name: "ci-bot" });
  const after = await dispatch(env, { kind: "bearer", token: t.secret }, "list_runs", {});
  expect(!after.ok && after.error.code).toBe("unauthenticated");
  const audit = await listAudit(db, { orgId: a.orgId });
  expect(audit.map((r) => [r.principalKind, r.principalId, r.op, r.outcome])).toContainEqual([
    "cli",
    "local",
    "revoke_api_token",
    "ok",
  ]);
  await expect(revokeTokenFromCli(db, t.id)).rejects.toThrow(/already revoked/);
  await expect(revokeTokenFromCli(db, "01HZZZZZZZZZZZZZZZZZZZZZZZ")).rejects.toThrow(/no token/);
});

test("token list and revoke run through the binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longshore-cli-"));
  try {
    const { openDatabase, createOrg } = await import("../src/db");
    const cliDb = openDatabase(join(dir, "longshore.db"));
    await createOrg(cliDb, { slug: "acme", name: "Acme" });
    cliDb.close();
    const main = join(import.meta.dir, "../src/main.ts");
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", "run", main, "token", ...args, "--data-dir", dir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { out, err, code };
    };
    const created = await run("create", "--org", "acme", "--role", "reader", "--name", "bot");
    expect(created.code).toBe(0);
    const secret = created.out.trim();
    const id = /token (\w{26}) for/.exec(created.err)![1]!;
    const listed = await run("list", "--org", "acme");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("bot");
    expect(listed.out).toContain("active");
    expect(listed.out).not.toContain(secret);
    const revoked = await run("revoke", id);
    expect(revoked.code).toBe(0);
    expect((await run("list", "--org", "acme")).out).toContain("revoked");
    expect((await run("revoke", id)).code).toBe(1);
    expect((await run("revoke")).code).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh data directory can mint a token for the built-in local org", async () => {
  const fresh = (await import("../src/db")).openDatabase(":memory:");
  const t = await createTokenFromCli(fresh, {
    org: "local",
    project: "local",
    role: "operator",
    name: "first",
  });
  expect(t).toMatchObject({ org: "local", project: "local", role: "operator" });
  const res = await dispatch(
    { registry, db: fresh },
    { kind: "bearer", token: t.secret },
    "list_runs",
    {},
  );
  expect(res.ok).toBe(true);
  await expect(
    createTokenFromCli(fresh, { org: "other", role: "reader", name: "x" }),
  ).rejects.toThrow(/no org/);
});
