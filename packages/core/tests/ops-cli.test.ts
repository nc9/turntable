import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, listAudit } from "../src/db";
import { schema } from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, hashToken, registry } from "../src/ops";
import { createTokenFromCli } from "../src/ops/token-cli";
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
    [{ role: "release_operator" }, /cannot be created from the CLI/],
    [{ org: "nope" }, /no org/],
    [{ project: "nope" }, /no project/],
    [{ name: "  " }, /--name/],
    [{ expiresInDays: 0 }, /expires-in-days/],
    [{ expiresInDays: 400 }, /expires-in-days/],
  ];
  for (const [patch, message] of cases) {
    await expect(createTokenFromCli(db, { ...opts, ...patch } as never)).rejects.toThrow(message);
  }
  expect(await db.orm.select().from(schema.apiTokens)).toHaveLength(0);
});

test("the CLI binary prints only the secret on stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turntable-cli-"));
  try {
    const { openDatabase, createOrg } = await import("../src/db");
    const cliDb = openDatabase(join(dir, "turntable.db"));
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
