import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrations } from "../src/db/migrations.generated";
import { applyMigrations, type Migration } from "../src/db/migrate";
import { checkMigrationShas, EDITED_IN_PLACE, migrationSha } from "../src/db/migration-sha";

const tiny: Migration[] = [
  { tag: "0000_a", when: 1, statements: ["CREATE TABLE a (id INTEGER)"] },
  { tag: "0001_b", when: 2, statements: ["CREATE TABLE b (id INTEGER)"] },
];
const shas = (db: Database) =>
  Object.fromEntries(
    db
      .query<{ tag: string; sha256: string | null }, []>(
        "SELECT tag, sha256 FROM __turntable_migrations",
      )
      .all()
      .map((r) => [r.tag, r.sha256]),
  );

describe("migration sha256 (sqlite)", () => {
  test("records the hash of each applied migration", () => {
    const db = new Database(":memory:");
    applyMigrations(db, tiny);
    expect(shas(db)).toEqual({
      "0000_a": migrationSha(tiny[0]!),
      "0001_b": migrationSha(tiny[1]!),
    });
  });

  test("a rebooted database with unchanged SQL applies nothing", () => {
    const db = new Database(":memory:");
    applyMigrations(db, tiny);
    expect(applyMigrations(db, tiny)).toEqual([]);
  });

  test("refuses to boot when an applied migration's SQL was edited, and changes nothing", () => {
    const db = new Database(":memory:");
    applyMigrations(db, tiny);
    const edited: Migration[] = [
      { ...tiny[0]!, statements: ["CREATE TABLE a (id INTEGER, extra TEXT)"] },
      tiny[1]!,
      { tag: "0002_c", when: 3, statements: ["CREATE TABLE c (id INTEGER)"] },
    ];
    expect(() => applyMigrations(db, edited)).toThrow(/0000_a.*immutable/s);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'c'").all()).toEqual([]);
  });

  test("a database from before hashes existed is backfilled, not refused", () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE __turntable_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    db.run("CREATE TABLE a (id INTEGER)");
    db.run("INSERT INTO __turntable_migrations VALUES ('0000_a', 1)");
    expect(applyMigrations(db, tiny)).toEqual(["0001_b"]);
    expect(shas(db)["0000_a"]).toBe(migrationSha(tiny[0]!));
    expect(shas(db)["0001_b"]).toBe(migrationSha(tiny[1]!));
  });

  test("a legacy-named, hashless table is renamed and backfilled", () => {
    const db = new Database(":memory:");
    applyMigrations(db, migrations);
    db.run("UPDATE __turntable_migrations SET sha256 = NULL");
    db.run("ALTER TABLE __turntable_migrations RENAME TO __longshore_migrations");
    expect(applyMigrations(db, migrations)).toEqual([]);
    expect(Object.values(shas(db)).every((s) => typeof s === "string")).toBe(true);
  });

  test("the whole shipped list boots twice", () => {
    const db = new Database(":memory:");
    applyMigrations(db, migrations);
    expect(applyMigrations(db, migrations)).toEqual([]);
  });
});

describe("EDITED_IN_PLACE allowlist", () => {
  const list = [tiny[0]!];
  test("an allowlisted earlier hash is accepted", () => {
    const allowed = { "0000_a": { shas: ["old"], reason: "test" } };
    expect(checkMigrationShas(new Map([["0000_a", "old"]]), list, allowed)).toEqual([]);
  });
  test("an unlisted hash is refused", () => {
    expect(() => checkMigrationShas(new Map([["0000_a", "old"]]), list, {})).toThrow(/0000_a/);
  });
  test("every entry has a reason and 0033 is listed", () => {
    for (const entry of Object.values(EDITED_IN_PLACE)) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.shas.length).toBeGreaterThan(0);
    }
    expect(EDITED_IN_PLACE["0033_outbound_webhooks"]).toBeDefined();
  });
  test("a database that applied the pre-#275 0033 boots", () => {
    const m = migrations.find((x) => x.tag === "0033_outbound_webhooks")!;
    const recorded = new Map([[m.tag, EDITED_IN_PLACE[m.tag]!.shas[0]!]]);
    expect(checkMigrationShas(recorded, [m])).toEqual([]);
  });
});
