import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";

// An AUTOINCREMENT table that is rebuilt (drizzle-kit does it to change a CHECK) gets a fresh
// sqlite_sequence row, so ids that were pruned would be handed out again. For the event feed that
// is a cursor meeting a reused id: a consumer skips or repeats events.
//
// This is behavioural, not a look at the SQL: every migration is applied in order to a database
// that holds rows in each AUTOINCREMENT table; after EACH migration the newest rows are pruned and
// the next insert must get an id above the highest id ever issued. A failure names the table and
// the migration. It covers every migration there is, so a later one inherits it.

const all = migrations.toSorted((a, b) => a.when - b.when);

type Db = Database;

// ---- generic rows: any AUTOINCREMENT table, found in sqlite_master, gets rows built from its own
// column list, so a table nobody thought of is guarded too. Only a CHECK that limits a column's
// values needs a hint below; a table that cannot be seeded fails the walk and says so.

/** Values a CHECK constraint needs (the column must be one of these). */
const HINTS: Record<string, Record<string, string | number>> = {
  events: { type: "run.queued" },
};

interface Col {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const FK_VALUE = "k1";
let counter = 0;

function columns(db: Db, table: string): Col[] {
  return db.query(`PRAGMA table_info(\`${table}\`)`).all() as Col[];
}

/** Inserts one row (and the parent rows its foreign keys need) and returns its integer id. */
function insertRow(db: Db, table: string, forced: Record<string, string | number> = {}): number {
  const cols = columns(db, table);
  const fks = db.query(`PRAGMA foreign_key_list(\`${table}\`)`).all() as {
    table: string;
    from: string;
    to: string;
  }[];
  const fkCols = new Set(fks.map((f) => f.from));
  // Parents first: every parent a NOT NULL foreign key column points at.
  for (const f of fks) {
    const c = cols.find((x) => x.name === f.from);
    if (!c || c.notnull === 0) continue;
    const parentCols = fks.filter((g) => g.table === f.table);
    const key = Object.fromEntries(parentCols.map((g) => [g.to, FK_VALUE]));
    const exists = db
      .query(
        `SELECT 1 FROM \`${f.table}\` WHERE ${Object.keys(key)
          .map((k) => `\`${k}\` = ?`)
          .join(" AND ")}`,
      )
      .get(...Object.values(key));
    if (!exists) insertRow(db, f.table, key);
  }
  const values: Record<string, string | number> = {};
  for (const c of cols) {
    const hint = HINTS[table]?.[c.name];
    if (forced[c.name] !== undefined) values[c.name] = forced[c.name]!;
    else if (hint !== undefined) values[c.name] = hint;
    else if (c.pk && /INT/i.test(c.type))
      continue; // the AUTOINCREMENT id itself
    else if (c.notnull && c.dflt_value === null) {
      values[c.name] = fkCols.has(c.name)
        ? FK_VALUE
        : /INT/i.test(c.type)
          ? 1
          : `${table}.${c.name}.${++counter}`;
    }
    // A nullable column, or one with a default, is left to its default.
  }
  const names = Object.keys(values);
  const sql = names.length
    ? `INSERT INTO \`${table}\` (${names.map((n) => `\`${n}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
    : `INSERT INTO \`${table}\` DEFAULT VALUES`;
  try {
    return Number(db.run(sql, Object.values(values)).lastInsertRowid);
  } catch (e) {
    throw new Error(
      `cannot seed ${table}: ${(e as Error).message}. Add a hint for it in HINTS in migration-sequence-guard.test.ts`,
      { cause: e },
    );
  }
}

/** Every AUTOINCREMENT table that exists now, found in sqlite_master. */
function autoincrementTables(db: Db): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .toSorted();
}

/**
 * `newest`: after each migration the newest rows are pruned (a gap at the top). `all`: every row is
 * deleted, so the next migration rebuilds an EMPTY table, which has no sqlite_sequence row to
 * update after the rebuild.
 */
function walk(prune: "newest" | "all"): void {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  /** The highest id ever issued, per table. */
  const issued = new Map<string, number>();
  const checked = new Set<string>();
  for (let k = 0; k < all.length; k++) {
    const tag = all[k]!.tag;
    applyMigrations(sqlite, all.slice(0, k + 1));
    for (const table of autoincrementTables(sqlite)) {
      const seed = (db: Db): number => insertRow(db, table);
      checked.add(table);
      if (!issued.has(table)) {
        // First seen: hand out six ids and prune the newest two. The high-water mark is 6.
        for (let i = 0; i < 6; i++) issued.set(table, seed(sqlite));
        sqlite.run(
          prune === "all"
            ? `DELETE FROM ${table}`
            : `DELETE FROM ${table} WHERE id >= ${issued.get(table)! - 1}`,
        );
      }
      // What SQLite itself says is the high-water mark must not have fallen below what we issued.
      const seq = (
        sqlite.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as {
          seq: number;
        } | null
      )?.seq;
      const before = issued.get(table)!;
      const id = seed(sqlite);
      if (id <= before) {
        throw new Error(
          `after ${tag}: ${table} handed out id ${id} again (the highest ever issued was ${before}; sqlite_sequence says ${seq})`,
        );
      }
      issued.set(table, id);
      // Prune the newest again, so the next migration is tested against a table with a gap at the top.
      sqlite.run(
        prune === "all" ? `DELETE FROM ${table}` : `DELETE FROM ${table} WHERE id >= ${id - 1}`,
      );
    }
  }
  // The tables that exist now are the ones that were guarded the whole way.
  expect([...checked].toSorted()).toEqual(autoincrementTables(sqlite));
  expect(checked.has("events")).toBe(true);
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

test("after every migration, no id of an AUTOINCREMENT table can be issued twice (newest rows pruned)", () => {
  walk("newest");
});

test("the same when EVERY row is pruned, so a rebuild meets an empty table", () => {
  walk("all");
});

// Every migration that rebuilds events: 0033 (outbound webhooks) and the last one, which drops the
// type CHECK (#345). Each, stripped of its guard, must be caught.
for (const suffix of ["_outbound_webhooks", "_approval_policy_settings"]) {
  test(`the guard catches a rebuild that forgets the sequence (${suffix})`, () => {
    // A migration list in which the events rebuild has lost its guard: the walk must fail,
    // naming the table and the migration.
    const i = all.findIndex((m) => m.tag.endsWith(suffix));
    expect(i).toBeGreaterThan(0);
    const unguarded = all.map((m, j) =>
      j === i
        ? {
            ...m,
            statements: m.statements.filter((s) => !/__events_seq|UPDATE sqlite_sequence/.test(s)),
          }
        : m,
    );
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, unguarded.slice(0, i));
    for (let t = 0; t < 6; t++) insertRow(sqlite, "events");
    sqlite.run("DELETE FROM events WHERE id >= 5");
    applyMigrations(sqlite, unguarded.slice(0, i + 1));
    const id = insertRow(sqlite, "events");
    expect(id).toBeLessThanOrEqual(6); // the id was handed out again: exactly what the guard looks for
  });
}

// The static half: a rebuild (`__new_<t>` created with AUTOINCREMENT) saves sqlite_sequence before
// the drop and restores it after the rename. Cheap, and it names the pattern; the walk above is
// the one that cannot be fooled by a different pattern.
const PRE_UPSERT = new Set(["0032_quota_events"]);
function rebuiltAutoincrement(statements: string[]): string[] {
  return statements.flatMap((s) => {
    const m = /^\s*CREATE TABLE `__new_([A-Za-z0-9_]+)`/.exec(s);
    return m && /AUTOINCREMENT/i.test(s) ? [m[1]!] : [];
  });
}

test("every rebuild of an AUTOINCREMENT table saves and restores sqlite_sequence (static)", () => {
  const rebuilds = all.flatMap((m) =>
    rebuiltAutoincrement(m.statements).map((table) => ({ m, table })),
  );
  expect(rebuilds.some((r) => r.table === "events")).toBe(true);
  for (const { m, table } of rebuilds) {
    const text = m.statements.join("\n");
    const save = text.search(
      new RegExp(
        `CREATE TEMP TABLE \`__${table}_seq\` AS SELECT seq FROM sqlite_sequence WHERE name = '${table}'`,
      ),
    );
    const drop = text.search(new RegExp(`DROP TABLE \`${table}\``));
    const rename = text.search(new RegExp(`RENAME TO \`${table}\``));
    const upsert = text.search(
      new RegExp(
        `INSERT INTO sqlite_sequence \\(name, seq\\) SELECT '${table}', coalesce\\(\\(SELECT max\\(seq\\) FROM \`__${table}_seq\`\\), 0\\) WHERE NOT EXISTS \\(SELECT 1 FROM sqlite_sequence WHERE name = '${table}'\\)`,
      ),
    );
    const restore = text.search(
      new RegExp(
        `UPDATE sqlite_sequence SET seq = max\\(seq, coalesce\\(\\(SELECT max\\(seq\\) FROM \`__${table}_seq\`\\), 0\\)\\) WHERE name = '${table}'`,
      ),
    );
    const where = `${m.tag}: ${table}`;
    expect([where, save >= 0 && save < drop]).toEqual([where, true]);
    expect([where, restore > rename && rename > drop]).toEqual([where, true]);
    // The restore is preceded by an upsert, so it cannot match nothing. 0032 predates it and is
    // already applied, so it is not edited: SQLite writes a sequence row even for an INSERT ... SELECT
    // of zero rows, and the empty-table walk above passes over it, which is the proof it is safe.
    if (!PRE_UPSERT.has(m.tag)) {
      expect([where, upsert > rename && upsert < restore]).toEqual([where, true]);
    }
  }
});
