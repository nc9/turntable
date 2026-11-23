import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrations } from "../src/db/migrations.pg.generated";
import { migrationSha } from "../src/db/migration-sha";
import { applyPgMigrations } from "../src/db/pg";

// The Postgres side of migration-sha.test.ts.
type Orm = ReturnType<typeof drizzle>;
const rows = async (orm: Orm, q: ReturnType<typeof sql>) =>
  ((await orm.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;
const tiny = [
  { tag: "0000_a", when: 1, statements: ["create table a (id integer)"] },
  { tag: "0001_b", when: 2, statements: ["create table b (id integer)"] },
];

test("records the hash, reboots cleanly, refuses an edited migration", async () => {
  const orm = drizzle(new PGlite());
  await applyPgMigrations(orm as never, tiny);
  const got = await rows(orm, sql`select tag, sha256 from __turntable_migrations order by tag`);
  expect(got.map((r) => r.sha256)).toEqual(tiny.map(migrationSha));
  expect(await applyPgMigrations(orm as never, tiny)).toEqual([]);
  const edited = [
    { ...tiny[0]!, statements: ["create table a (id integer, extra text)"] },
    tiny[1]!,
    { tag: "0002_c", when: 3, statements: ["create table c (id integer)"] },
  ];
  await expect(applyPgMigrations(orm as never, edited)).rejects.toThrow(/0000_a.*immutable/s);
  expect(await rows(orm, sql`select to_regclass('c') as t`)).toEqual([{ t: null }]);
});

test("a table from before hashes existed is backfilled, not refused", async () => {
  const orm = drizzle(new PGlite());
  await orm.execute(
    sql`create table __turntable_migrations (tag text primary key, applied_at bigint not null)`,
  );
  await orm.execute(sql`create table a (id integer)`);
  await orm.execute(sql`insert into __turntable_migrations values ('0000_a', 1)`);
  expect(await applyPgMigrations(orm as never, tiny)).toEqual(["0001_b"]);
  const got = await rows(orm, sql`select tag, sha256 from __turntable_migrations order by tag`);
  expect(got.map((r) => r.sha256)).toEqual(tiny.map(migrationSha));
});

test("the whole shipped list boots twice", async () => {
  const orm = drizzle(new PGlite());
  await applyPgMigrations(orm as never, migrations);
  expect(await applyPgMigrations(orm as never, migrations)).toEqual([]);
});

test("two concurrent boots on one fresh database both succeed, one sha256 column", async () => {
  const orm = drizzle(new PGlite());
  const results = await Promise.allSettled([
    applyPgMigrations(orm as never, tiny),
    applyPgMigrations(orm as never, tiny),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  const cols = await rows(
    orm,
    sql`select column_name from information_schema.columns where table_name = '__turntable_migrations' and column_name = 'sha256'`,
  );
  expect(cols).toHaveLength(1);
});
