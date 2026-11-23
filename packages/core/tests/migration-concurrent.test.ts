import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { applyMigrations, type Migration } from "../src/db/migrate";
import { applyPgMigrations } from "../src/db/pg";

// Two processes booting at once must both succeed and leave one sha256 column.
const tiny: Migration[] = [{ tag: "0000_a", when: 1, statements: ["CREATE TABLE a (id INTEGER)"] }];

test("two concurrent boots on one fresh sqlite file both succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-mig-"));
  try {
    const path = join(dir, "t.db");
    const open = () => {
      const db = new Database(path, { create: true, strict: true });
      db.run("PRAGMA busy_timeout = 5000");
      return db;
    };
    const [a, b] = [open(), open()];
    const results = await Promise.allSettled([
      Promise.resolve().then(() => applyMigrations(a, tiny)),
      Promise.resolve().then(() => applyMigrations(b, tiny)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const cols = a
      .query<{ name: string }, []>("PRAGMA table_info(__turntable_migrations)")
      .all()
      .filter((c) => c.name === "sha256");
    expect(cols).toHaveLength(1);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two real processes on one fresh file, started together: each migration applies in exactly one of
// them, with no "already exists" error and one row per migration.
test("two processes booting together apply each sqlite migration exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-mig-"));
  try {
    const path = join(dir, "t.db");
    const count = 25;
    const startAt = Date.now() + 1500;
    const worker = join(import.meta.dir, "helpers", "migrate-worker.ts");
    const procs = [0, 1].map(() =>
      Bun.spawn([process.execPath, worker, path, String(startAt), String(count)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outs = await Promise.all(
      procs.map(async (p) => ({
        code: await p.exited,
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
      })),
    );
    for (const o of outs) expect(o.err).not.toMatch(/already exists/);
    expect(outs.map((o) => o.code)).toEqual([0, 0]);
    const applied = outs.flatMap((o) => JSON.parse(o.out) as string[]);
    expect(applied).toHaveLength(count);
    expect(new Set(applied).size).toBe(count);
    const db = new Database(path, { strict: true });
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM __turntable_migrations").get()!.n,
    ).toBe(count);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PGlite has one connection, so the two calls queue rather than interleave; the advisory lock and
// the read inside it are what make this safe on a real server.
test("two concurrent pg boots apply each migration exactly once", async () => {
  const orm = drizzle(new PGlite());
  const list: Migration[] = Array.from({ length: 5 }, (_, i) => ({
    tag: `000${i}_t${i}`,
    when: i + 1,
    statements: [`create table t${i} (id integer)`],
  }));
  const results = await Promise.all([
    applyPgMigrations(orm as never, list),
    applyPgMigrations(orm as never, list),
  ]);
  expect(results.flat().toSorted()).toEqual(list.map((m) => m.tag));
  const rows = (await orm.execute(
    sql`select count(*)::int as n from __turntable_migrations`,
  )) as unknown as {
    rows: { n: number }[];
  };
  expect(rows.rows[0]!.n).toBe(5);
});
