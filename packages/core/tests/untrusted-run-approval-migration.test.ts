// The migration that moves `untrusted_run_approval` onto the settings table (#321): every
// project keeps the value its column held, on both dialects, and a second run changes nothing.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";
import { applyPgMigrations } from "../src/db/pg";

const TAG = "_untrusted_run_approval_to_settings";
const POLICIES = [
  ["p1", "o1", "no_agents"],
  ["p2", "o1", "any"],
  ["p3", "o2", "human"],
] as const;
const EXPECTED = POLICIES.map(([id, org, v]) => ({
  scope_id: id,
  org_id: org,
  value: JSON.stringify(v),
  updated_by: "migration",
}));

test("sqlite: each project's value moves to the settings table", () => {
  const db = new Database(":memory:");
  const at = migrations.findIndex((m) => m.tag.endsWith(TAG));
  expect(at).toBeGreaterThan(0);
  applyMigrations(db, migrations.slice(0, at));
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'one', 'One'), ('o2', 'two', 'Two')");
  for (const [id, org, v] of POLICIES) {
    db.run(
      `INSERT INTO projects (id, org_id, slug, name, untrusted_run_approval) VALUES ('${id}', '${org}', '${id}', '${id}', '${v}')`,
    );
  }
  applyMigrations(db, migrations);
  const rows = db
    .query(
      "SELECT scope_id, org_id, value, updated_by FROM settings WHERE scope_kind = 'project' AND key = 'untrusted_run_approval' ORDER BY scope_id",
    )
    .all();
  expect(rows).toEqual(EXPECTED);
  // the column is left in place, untouched
  expect(
    db.query("SELECT untrusted_run_approval AS v FROM projects WHERE id = 'p2'").get(),
  ).toEqual({ v: "any" });
});

test("postgres: each project's value moves to the settings table", async () => {
  const client = new PGlite();
  const orm = drizzle(client);
  try {
    const at = pgMigrations.findIndex((m) => m.tag.endsWith(TAG));
    expect(at).toBeGreaterThan(0);
    await applyPgMigrations(orm as never, pgMigrations.slice(0, at));
    await orm.execute(
      sql`insert into orgs (id, slug, name) values ('o1', 'one', 'One'), ('o2', 'two', 'Two')`,
    );
    for (const [id, org, v] of POLICIES) {
      await orm.execute(
        sql`insert into projects (id, org_id, slug, name, untrusted_run_approval) values (${id}, ${org}, ${id}, ${id}, ${v})`,
      );
    }
    await applyPgMigrations(orm as never, pgMigrations);
    const r = (await orm.execute(
      sql`select scope_id, org_id, value, updated_by from settings where scope_kind = 'project' and key = 'untrusted_run_approval' order by scope_id`,
    )) as unknown as { rows: unknown[] };
    expect(r.rows).toEqual(EXPECTED);
  } finally {
    await client.close();
  }
});
