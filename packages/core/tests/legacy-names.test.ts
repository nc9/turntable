import { PGlite } from "@electric-sql/pglite";
import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import {
  migrateLegacyDbFiles,
  migrateLegacyMigrationsTable,
  migrateLegacyPgMigrationsTable,
} from "../src/db/legacy-names";
import { migrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";
import { applyMigrations } from "../src/db/migrate";
import { applyPgMigrations } from "../src/db/pg";
import {
  generateInstanceToken,
  generateToken,
  hashToken,
  looksLikeInstanceToken,
  looksLikeToken,
} from "../src/ops/tokens";

const tmp = mkdtempSync(join(tmpdir(), "tt-legacy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(tmp, "d-"));

describe("database file rename", () => {
  test("longshore.db and its wal/shm move to turntable.db when the new one is missing", async () => {
    const dir = fresh();
    for (const s of ["", "-wal", "-shm"]) writeFileSync(join(dir, `longshore.db${s}`), `x${s}`);
    expect(migrateLegacyDbFiles(join(dir, "turntable.db"))).toBe(true);
    for (const s of ["", "-wal", "-shm"]) {
      expect(existsSync(join(dir, `longshore.db${s}`))).toBe(false);
      expect(await Bun.file(join(dir, `turntable.db${s}`)).text()).toBe(`x${s}`);
    }
  });

  test("an existing turntable.db is never overwritten, and other paths are left alone", () => {
    const dir = fresh();
    writeFileSync(join(dir, "longshore.db"), "old");
    writeFileSync(join(dir, "turntable.db"), "new");
    expect(migrateLegacyDbFiles(join(dir, "turntable.db"))).toBe(false);
    expect(existsSync(join(dir, "longshore.db"))).toBe(true);
    expect(migrateLegacyDbFiles(":memory:")).toBe(false);
    expect(migrateLegacyDbFiles(join(dir, "other.db"))).toBe(false);
  });

  test("a real old database keeps its data after openDatabase renames and reopens it", async () => {
    const dir = fresh();
    // Build an "old" database: migrated under the old table name, with a row in it.
    const raw = new Database(join(dir, "longshore.db"), { create: true });
    raw.run("PRAGMA journal_mode = WAL");
    applyMigrations(raw, migrations);
    raw.run("ALTER TABLE __turntable_migrations RENAME TO __longshore_migrations");
    raw.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'legacy', 'Legacy')");
    raw.close();

    const db = openDatabase(join(dir, "turntable.db"));
    const { getOrgBySlug } = await import("../src/db");
    expect((await getOrgBySlug(db, "legacy"))?.id).toBe("o1");
    db.close();
    expect(existsSync(join(dir, "longshore.db"))).toBe(false);
  });
});

describe("migrations table rename (SQLite)", () => {
  const names = (s: Database): string[] =>
    s
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%migrations' ESCAPE '\\'",
      )
      .all()
      .map((r) => r.name);

  test("an old table is renamed in place, so applied migrations are not run again", () => {
    const s = new Database(":memory:");
    applyMigrations(s, migrations);
    s.run("ALTER TABLE __turntable_migrations RENAME TO __longshore_migrations");
    expect(migrateLegacyMigrationsTable(s)).toBe(true);
    expect(applyMigrations(s, migrations)).toEqual([]);
    expect(names(s)).toEqual(["__turntable_migrations"]);
  });

  test("applyMigrations on a database that has the old name takes the same path", () => {
    const s = new Database(":memory:");
    applyMigrations(s, migrations);
    s.run("ALTER TABLE __turntable_migrations RENAME TO __longshore_migrations");
    expect(applyMigrations(s, migrations)).toEqual([]);
    expect(names(s)).toEqual(["__turntable_migrations"]);
  });

  test("a fresh database gets the new table only; a current one is left alone", () => {
    const s = new Database(":memory:");
    expect(migrateLegacyMigrationsTable(s)).toBe(false);
    applyMigrations(s, migrations);
    expect(migrateLegacyMigrationsTable(s)).toBe(false);
    expect(names(s)).toEqual(["__turntable_migrations"]);
  });

  test("both tables present is refused with a clear error, and nothing is changed", () => {
    const s = new Database(":memory:");
    applyMigrations(s, migrations);
    s.run(
      "CREATE TABLE __longshore_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    expect(() => migrateLegacyMigrationsTable(s)).toThrow(
      /both __turntable_migrations and __longshore_migrations/,
    );
    expect(() => applyMigrations(s, migrations)).toThrow(/refusing to guess/);
    expect(names(s).toSorted()).toEqual(["__longshore_migrations", "__turntable_migrations"]);
  });
});

describe("migrations table rename (Postgres, PGlite)", () => {
  const tables = async (orm: ReturnType<typeof drizzle>): Promise<string[]> => {
    const raw = (await orm.execute(
      sql`select table_name from information_schema.tables where table_name like '\\_\\_%migrations' order by 1`,
    )) as unknown as { table_name: string }[] | { rows: { table_name: string }[] };
    return (Array.isArray(raw) ? raw : raw.rows).map((r) => r.table_name);
  };

  test("an old table is renamed in place and nothing re-runs; both tables is refused", async () => {
    const client = new PGlite();
    const orm = drizzle(client);
    try {
      await applyPgMigrations(orm as never, pgMigrations);
      expect(await tables(orm)).toEqual(["__turntable_migrations"]);
      await orm.execute(sql`alter table __turntable_migrations rename to __longshore_migrations`);
      expect(await applyPgMigrations(orm as never, pgMigrations)).toEqual([]);
      expect(await tables(orm)).toEqual(["__turntable_migrations"]);

      await orm.execute(
        sql`create table __longshore_migrations (tag text primary key, applied_at bigint not null)`,
      );
      await expect(applyPgMigrations(orm as never, pgMigrations)).rejects.toThrow(
        /both __turntable_migrations and __longshore_migrations/,
      );
      await expect(migrateLegacyPgMigrationsTable(orm as never)).rejects.toThrow(
        /refusing to guess/,
      );
    } finally {
      await client.close();
    }
  });
});

describe("token prefix", () => {
  test("new tokens are tt_ and tti_; the pre-rename ls_ and lsi_ are still recognised", () => {
    const fresh = generateToken();
    expect(fresh.startsWith("tt_")).toBe(true);
    expect(looksLikeToken(fresh)).toBe(true);
    const instance = generateInstanceToken();
    expect(instance.startsWith("tti_")).toBe(true);
    expect(looksLikeInstanceToken(instance)).toBe(true);
    expect(looksLikeToken(instance)).toBe(false);

    const legacy = `ls_${"a".repeat(43)}`;
    expect(looksLikeToken(legacy)).toBe(true);
    expect(looksLikeInstanceToken(`lsi_${"a".repeat(43)}`)).toBe(true);
    expect(looksLikeToken(`lsi_${"a".repeat(43)}`)).toBe(false);
    expect(looksLikeToken(`xx_${"a".repeat(43)}`)).toBe(false);
    expect(looksLikeToken(`ls_${"a".repeat(42)}`)).toBe(false);
    expect(looksLikeInstanceToken(`lsi_${"a".repeat(42)}`)).toBe(false);
  });

  test("a stored legacy token (by hash) still authenticates", async () => {
    const { insertApiToken, findApiTokenByHash, ensureLocalTenant } = await import("../src/db");
    const db = openDatabase(":memory:");
    const scope = await ensureLocalTenant(db);
    const legacy = `ls_${"b".repeat(43)}`;
    await insertApiToken(
      db,
      { orgId: scope.orgId },
      {
        name: "old",
        role: "reader",
        tokenHash: hashToken(legacy),
        createdBy: "test",
      },
    );
    expect((await findApiTokenByHash(db, hashToken(legacy)))?.name).toBe("old");
  });
});
