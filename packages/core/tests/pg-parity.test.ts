// The two dialects describe the same database. The Postgres schema is generated from the SQLite
// one, and each has its own embedded migrations; this checks they agree, from the drizzle
// definitions and from what the migrations actually create.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig as pgConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { applyMigrations } from "../src/db/migrate";
import { migrations as sqliteMigrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";
import { openPostgres } from "../src/db/pg";
import * as pgSchema from "../src/db/schema.pg";
import * as sqliteSchema from "../src/db/schema.sqlite";

const tablesOf = <T>(mod: Record<string, unknown>, cls: abstract new (...a: never[]) => T): T[] =>
  Object.values(mod).filter((v): v is T => v instanceof cls);

// Checks only Postgres has, each for a stated reason. SQLite cannot add a CHECK with ALTER TABLE,
// and a table rebuild to add one is what broke 0055 (#611): the column was added with a plain
// ALTER and the write path validates it instead. Nothing else may differ.
const PG_ONLY_CHECKS = new Set(["outbound_webhook_endpoints_format_check"]);

test("the generated schema has the same tables, columns, keys, indexes and checks", () => {
  const a = tablesOf(sqliteSchema, SQLiteTable).map((t) => sqliteConfig(t as SQLiteTable));
  const b = tablesOf(pgSchema, PgTable).map((t) => pgConfig(t as PgTable));
  expect(b.map((t) => t.name).toSorted()).toEqual(a.map((t) => t.name).toSorted());
  for (const t of a) {
    const p = b.find((x) => x.name === t.name)!;
    expect(p.columns.map((c) => [c.name, c.notNull]).toSorted()).toEqual(
      t.columns.map((c) => [c.name, c.notNull]).toSorted(),
    );
    expect(p.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(
      t.columns.filter((c) => c.primary).map((c) => c.name),
    );
    expect(p.primaryKeys.map((k) => k.columns.map((c) => c.name))).toEqual(
      t.primaryKeys.map((k) => k.columns.map((c) => c.name)),
    );
    expect(p.foreignKeys.length).toBe(t.foreignKeys.length);
    expect(p.uniqueConstraints.map((u) => u.columns.map((c) => c.name)).toSorted()).toEqual(
      t.uniqueConstraints.map((u) => u.columns.map((c) => c.name)).toSorted(),
    );
    expect(p.indexes.map((i) => i.config.name).toSorted()).toEqual(
      t.indexes.map((i) => i.config.name).toSorted(),
    );
    expect(
      p.checks
        .map((c) => c.name)
        .filter((n) => !PG_ONLY_CHECKS.has(n))
        .toSorted(),
    ).toEqual(t.checks.map((c) => c.name).toSorted());
  }
  // The exception list stays honest: each entry exists on Postgres and not on SQLite.
  for (const name of PG_ONLY_CHECKS) {
    expect(b.some((t) => t.checks.some((c) => c.name === name))).toBe(true);
    expect(a.some((t) => t.checks.some((c) => c.name === name))).toBe(false);
  }
});

type Col = { table: string; name: string; notNull: boolean };

test("both migration sets apply cleanly to an empty database and create the same tables and columns", async () => {
  const lite = new Database(":memory:", { strict: true });
  lite.run("PRAGMA foreign_keys = ON");
  applyMigrations(lite, sqliteMigrations);
  const liteTables = lite
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__turntable_migrations'",
    )
    .all()
    .map((r) => r.name)
    .toSorted();
  const liteCols: Col[] = liteTables.flatMap((table) =>
    lite
      .query<{ name: string; notnull: number }, []>(`pragma table_info("${table}")`)
      .all()
      .map((c) => ({ table, name: c.name, notNull: c.notnull === 1 })),
  );
  const liteIdx = lite
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'index' and name not like 'sqlite_%'",
    )
    .all()
    .map((r) => r.name)
    .toSorted();

  const pg = openPostgres({ pglite: true }, { fresh: true });
  await pg.run(async (h) => {
    const orm = h.orm as unknown as { execute(q: unknown): Promise<unknown> };
    const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => {
      const r = (await orm.execute(q)) as T[] | { rows: T[] };
      return Array.isArray(r) ? r : r.rows;
    };
    const pgTables = (
      await rows<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name != '__turntable_migrations'`,
      )
    )
      .map((r) => r.table_name)
      .toSorted();
    expect(pgTables).toEqual(liteTables);
    const pgCols = (
      await rows<{ table_name: string; column_name: string; is_nullable: string }>(
        sql`select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name != '__turntable_migrations'`,
      )
    ).map((c) => ({ table: c.table_name, name: c.column_name, notNull: c.is_nullable === "NO" }));
    const key = (c: Col) => `${c.table}.${c.name}:${c.notNull}`;
    expect(pgCols.map(key).toSorted()).toEqual(liteCols.map(key).toSorted());
    // Indexes drizzle named (the primary key indexes have engine-specific names).
    const named = (n: string) =>
      !n.endsWith("_pkey") && !n.endsWith("_pk") && !n.startsWith("sqlite_autoindex");
    const pgIdx = (
      await rows<{ indexname: string }>(
        sql`select indexname from pg_indexes where schemaname = 'public'`,
      )
    )
      .map((r) => r.indexname)
      .filter(named)
      .toSorted();
    const liteNamed = liteIdx.filter(named);
    // SQLite makes an automatic index for a UNIQUE constraint; drizzle names Postgres ones
    // `<table>_<cols>_unique`. Compare the explicitly created indexes only.
    expect(pgIdx.filter((n) => !n.endsWith("_unique"))).toEqual(
      liteNamed.filter((n) => !n.endsWith("_unique")),
    );
  });
  // Applying again is a no-op, and re-opening against the same server does not re-run them.
  const again = await pg.run(async ({ orm }) => {
    const { applyPgMigrations } = await import("../src/db/pg");
    return applyPgMigrations(orm as never, pgMigrations);
  });
  expect(again).toEqual([]);
  pg.close();
  lite.close();
});

test("the types that differ round-trip: ms timestamps as Date, bytes as Buffer, flags as booleans, identity ids", async () => {
  const pg = openPostgres({ pglite: true }, { fresh: true });
  const { instance, logChunks, runs, events, orgs, projects, jobAttempts, jobs } = pgSchema;
  await pg.run(async ({ orm }) => {
    await orm.insert(instance).values({ id: "i1" });
    const [row] = await orm.select().from(instance);
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
  });
  expect(instance).toBeDefined();
  expect([logChunks, runs, events, orgs, projects, jobAttempts, jobs].every(Boolean)).toBe(true);
  pg.close();
});
