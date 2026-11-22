import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { migrateLegacyDbFiles, migrateLegacyMigrationsTable } from "../src/db/legacy-names";
import { migrations } from "../src/db/migrations.generated";
import { applyMigrations } from "../src/db/migrate";
import { generateToken, hashToken, looksLikeToken } from "../src/ops/tokens";

const tmp = mkdtempSync(join(tmpdir(), "ls-legacy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const fresh = (): string => mkdtempSync(join(tmp, "d-"));

describe("database file rename", () => {
  test("turntable.db and its wal/shm move to longshore.db when the new one is missing", async () => {
    const dir = fresh();
    for (const s of ["", "-wal", "-shm"]) writeFileSync(join(dir, `turntable.db${s}`), `x${s}`);
    expect(migrateLegacyDbFiles(join(dir, "longshore.db"))).toBe(true);
    for (const s of ["", "-wal", "-shm"]) {
      expect(existsSync(join(dir, `turntable.db${s}`))).toBe(false);
      expect(await Bun.file(join(dir, `longshore.db${s}`)).text()).toBe(`x${s}`);
    }
  });

  test("an existing longshore.db is never overwritten, and other paths are left alone", () => {
    const dir = fresh();
    writeFileSync(join(dir, "turntable.db"), "old");
    writeFileSync(join(dir, "longshore.db"), "new");
    expect(migrateLegacyDbFiles(join(dir, "longshore.db"))).toBe(false);
    expect(existsSync(join(dir, "turntable.db"))).toBe(true);
    expect(migrateLegacyDbFiles(":memory:")).toBe(false);
    expect(migrateLegacyDbFiles(join(dir, "other.db"))).toBe(false);
  });

  test("a real old database keeps its data after openDatabase renames and reopens it", async () => {
    const dir = fresh();
    // Build an "old" database: migrated under the old table name, with a row in it.
    const old = openDatabase(join(dir, "scratch.db"));
    old.close();
    const raw = new Database(join(dir, "turntable.db"), { create: true });
    raw.run("PRAGMA journal_mode = WAL");
    applyMigrations(raw, migrations);
    raw.run("ALTER TABLE __longshore_migrations RENAME TO __turntable_migrations");
    raw.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'legacy', 'Legacy')");
    raw.close();

    const db = openDatabase(join(dir, "longshore.db"));
    const { getOrgBySlug } = await import("../src/db");
    expect((await getOrgBySlug(db, "legacy"))?.id).toBe("o1");
    db.close();
    expect(existsSync(join(dir, "turntable.db"))).toBe(false);
  });
});

describe("migrations table rename", () => {
  test("an old table is renamed in place, so applied migrations are not run again", () => {
    const s = new Database(":memory:");
    applyMigrations(s, migrations);
    s.run("ALTER TABLE __longshore_migrations RENAME TO __turntable_migrations");
    expect(migrateLegacyMigrationsTable(s)).toBe(true);
    expect(applyMigrations(s, migrations)).toEqual([]);
    const names = s
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%migrations' ESCAPE '\\'",
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["__longshore_migrations"]);
  });

  test("a fresh database just gets the new table; both tables present is left alone", () => {
    const s = new Database(":memory:");
    expect(migrateLegacyMigrationsTable(s)).toBe(false);
    applyMigrations(s, migrations);
    s.run(
      "CREATE TABLE __turntable_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    expect(migrateLegacyMigrationsTable(s)).toBe(false);
  });
});

describe("token prefix", () => {
  test("new tokens are ls_; old tt_ tokens are still recognised", () => {
    const fresh = generateToken();
    expect(fresh.startsWith("ls_")).toBe(true);
    expect(looksLikeToken(fresh)).toBe(true);
    const legacy = `tt_${"a".repeat(43)}`;
    expect(looksLikeToken(legacy)).toBe(true);
    expect(looksLikeToken(`xx_${"a".repeat(43)}`)).toBe(false);
    expect(looksLikeToken(`tt_${"a".repeat(42)}`)).toBe(false);
  });

  test("a stored legacy token (by hash) still authenticates", async () => {
    const { insertApiToken, findApiTokenByHash, ensureLocalTenant } = await import("../src/db");
    const db = openDatabase(":memory:");
    const scope = await ensureLocalTenant(db);
    const legacy = `tt_${"b".repeat(43)}`;
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
