// The migration that drops the events type CHECK (#345) is the LAST rebuild of the events table.
// It must keep every row, the id high-water mark (a feed cursor never meets a reused id), the
// indexes and the foreign keys, on SQLite and Postgres; it must not depend on `PRAGMA
// foreign_keys=OFF` (a no-op inside a transaction); and it must stay quick on a hosted-sized feed.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";
import { applyPgMigrations } from "../src/db/pg";

const TAG = "_approval_policy_settings";
const at = migrations.findIndex((m) => m.tag.endsWith(TAG));
const pgAt = pgMigrations.findIndex((m) => m.tag.endsWith(TAG));

/** Events 1..10 and 12, so ids 4, 7 and 11 are gaps; 13 is inserted and deleted: seq 13, max 12. */
function seedGaps(db: Database): void {
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'one', 'One')");
  db.run("INSERT INTO projects (id, org_id, slug, name) VALUES ('p1', 'o1', 'app', 'App')");
  for (let i = 1; i <= 13; i++) {
    db.run(
      `INSERT INTO events (public_id, org_id, project_id, type, payload) VALUES ('e${i}', 'o1', ${i % 2 ? "'p1'" : "NULL"}, 'run.queued', '{"n":${i}}')`,
    );
  }
  db.run("DELETE FROM events WHERE id IN (4, 7, 11, 13)");
}

function shape(db: Database) {
  const indexes = (
    db
      .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .all() as { name: string; sql: string | null }[]
  )
    .filter((i) => !i.name.startsWith("sqlite_autoindex") || i.sql === null)
    .map((i) => ({
      name: i.name,
      list: (db.query("PRAGMA index_list(events)").all() as { name: string; unique: number }[])
        .filter((l) => l.name === i.name)
        .map((l) => l.unique),
      columns: (db.query(`PRAGMA index_info(\`${i.name}\`)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const fks = (
    db.query("PRAGMA foreign_key_list(events)").all() as {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[]
  )
    .map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`)
    .toSorted();
  return {
    count: db.query("SELECT count(*) AS n FROM events").get(),
    max: db.query("SELECT max(id) AS m FROM events").get(),
    ids: db.query("SELECT id, public_id, payload FROM events ORDER BY id").all(),
    seq: db.query("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get(),
    indexes,
    fks,
  };
}

test("sqlite: rows, id high-water mark, indexes and foreign keys survive; the CHECK is gone", () => {
  expect(at).toBeGreaterThan(0);
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, migrations.slice(0, at));
  seedGaps(db);
  const before = shape(db);
  expect(before.count).toEqual({ n: 9 });
  expect(before.max).toEqual({ m: 12 });
  expect(before.seq).toEqual({ seq: 13 }); // above max(id): the max row was deleted
  expect(before.indexes.map((i) => i.name)).toEqual([
    "events_org_idx",
    "events_org_project_idx",
    "events_public_id_unique",
  ]);
  expect(before.fks.length).toBe(3); // org_id, plus the two columns of the composite project key

  applyMigrations(db, migrations.slice(0, at + 1));
  expect(shape(db)).toEqual(before);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  // the next insert continues after the high-water mark, never reusing 13
  db.run("INSERT INTO events (public_id, org_id, type) VALUES ('next', 'o1', 'run.queued')");
  expect(db.query("SELECT id FROM events WHERE public_id = 'next'").get()).toEqual({ id: 14 });
  // and the type is no longer constrained by the database
  db.run("INSERT INTO events (public_id, org_id, type) VALUES ('any', 'o1', 'future.type')");
  const ddl = db.query("SELECT sql FROM sqlite_master WHERE name = 'events'").get() as {
    sql: string;
  };
  expect(ddl.sql).not.toMatch(/CHECK/i);
});

test("sqlite: nothing references events, so the DROP cannot cascade or fail on referencing rows", () => {
  const db = new Database(":memory:");
  applyMigrations(db, migrations);
  const refs = (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).filter((t) =>
    (db.query(`PRAGMA foreign_key_list(\`${t.name}\`)`).all() as { table: string }[]).some(
      (f) => f.table === "events",
    ),
  );
  expect(refs).toEqual([]);
});

test("sqlite: the rebuild holds with foreign keys ON inside a transaction (the PRAGMA is a no-op there)", () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  applyMigrations(db, migrations.slice(0, at));
  seedGaps(db);
  const before = shape(db);
  // Run the statements as a transaction runner would, without the migration's own PRAGMA lines.
  const m = migrations[at]!;
  db.transaction(() => {
    for (const s of m.statements) if (!/^\s*PRAGMA foreign_keys/i.test(s)) db.run(s);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  })();
  expect(shape(db)).toEqual(before);
});

test("sqlite: 12,000 events of about 400 bytes migrate in well under 5 s", () => {
  const db = new Database(":memory:");
  applyMigrations(db, migrations.slice(0, at));
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'one', 'One')");
  const insert = db.prepare(
    "INSERT INTO events (public_id, org_id, type, run_id, payload) VALUES (?, 'o1', 'run.queued', ?, ?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      insert.run(`ev${i}`, `run${i}`, JSON.stringify({ n: i, note: "x".repeat(360) }));
    }
  })();
  const start = performance.now();
  applyMigrations(db, migrations.slice(0, at + 1));
  const ms = performance.now() - start;
  console.log(`events-check-drop: 12000 rows migrated in ${ms.toFixed(1)} ms`);
  expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 12000 });
  expect(ms).toBeLessThan(5000);
});

test("postgres: rows, id sequence and indexes survive; the CHECK is gone", async () => {
  expect(pgAt).toBeGreaterThan(0);
  const client = new PGlite();
  const orm = drizzle(client);
  const rows = async (q: ReturnType<typeof sql>) =>
    ((await orm.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;
  const state = async () => ({
    ids: await rows(sql`select id, public_id, payload from events order by id`),
    indexes: await rows(
      sql`select indexname, indexdef from pg_indexes where tablename = 'events' order by indexname`,
    ),
    fks: await rows(
      sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'events'::regclass and contype = 'f' order by conname`,
    ),
  });
  try {
    await applyPgMigrations(orm as never, pgMigrations.slice(0, pgAt));
    await orm.execute(sql`insert into orgs (id, slug, name) values ('o1', 'one', 'One')`);
    for (let i = 1; i <= 13; i++) {
      await orm.execute(
        sql`insert into events (public_id, org_id, type, payload) values (${"e" + i}, 'o1', 'run.queued', '{}')`,
      );
    }
    await orm.execute(sql`delete from events where id in (4, 7, 11, 13)`);
    const before = await state();
    expect(before.ids.length).toBe(9);
    expect(
      (
        await rows(
          sql`select count(*)::int as n from pg_constraint where conname = 'events_type_check'`,
        )
      )[0],
    ).toEqual({ n: 1 });
    await applyPgMigrations(orm as never, pgMigrations.slice(0, pgAt + 1));
    expect(await state()).toEqual(before);
    expect(
      (
        await rows(
          sql`select count(*)::int as n from pg_constraint where conname = 'events_type_check'`,
        )
      )[0],
    ).toEqual({ n: 0 });
    const next = await rows(
      sql`insert into events (public_id, org_id, type) values ('next', 'o1', 'future.type') returning id`,
    );
    expect(next).toEqual([{ id: 14 }]);
  } finally {
    await client.close();
  }
});
