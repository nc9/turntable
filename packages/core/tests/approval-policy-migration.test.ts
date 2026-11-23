// The migration that moves approval policies onto the settings table (#345): every org keeps the
// policy its rows held, on both dialects, an org that already has the setting is left alone, and
// the events table rebuild keeps its id high-water mark.
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
const ROWS = [
  ["o1", "release", 1, 1],
  ["o1", "production", 3, 0],
  ["o2", "staging", 2, 0],
] as const;
const EXPECTED = [
  {
    org_id: "o1",
    value: {
      release: { required: 1, allow_author_approval: true, key_policy: "any" },
      production: { required: 3, allow_author_approval: false, key_policy: "any" },
    },
  },
  {
    org_id: "o2",
    value: { staging: { required: 2, allow_author_approval: false, key_policy: "any" } },
  },
];
const KEPT = { kept: { required: 1, allow_author_approval: false, key_policy: "any" } };
const parsed = (rows: { org_id: string; value: string }[]) =>
  rows.map((r) => ({ org_id: r.org_id, value: JSON.parse(r.value) }));

test("sqlite: each org's policies become one approval_policy setting, the table stays", () => {
  const db = new Database(":memory:");
  const at = migrations.findIndex((m) => m.tag.endsWith(TAG));
  expect(at).toBeGreaterThan(0);
  applyMigrations(db, migrations.slice(0, at));
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'one', 'One'), ('o2', 'two', 'Two')");
  for (const [org, env, required, author] of ROWS) {
    db.run(
      `INSERT INTO approval_policies (org_id, environment, required, allow_author_approval, updated_by, updated_at) VALUES ('${org}', '${env}', ${required}, ${author}, 'cli', 1)`,
    );
  }
  // an org that already has the setting keeps it
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o3', 'three', 'Three')");
  db.run(
    "INSERT INTO approval_policies (org_id, environment, required, updated_by, updated_at) VALUES ('o3', 'old', 2, 'cli', 1)",
  );
  db.run(
    `INSERT INTO settings (scope_kind, scope_id, org_id, key, value, updated_by, updated_at) VALUES ('org', 'o3', 'o3', 'approval_policy', '${JSON.stringify(KEPT)}', 't', 1)`,
  );
  // events written before the rebuild keep their ids, and the next one is higher
  db.run("INSERT INTO events (public_id, org_id, type) VALUES ('e1', 'o1', 'run.queued')");
  db.run("INSERT INTO events (public_id, org_id, type) VALUES ('e2', 'o1', 'run.queued')");
  db.run("DELETE FROM events WHERE public_id = 'e2'");
  applyMigrations(db, migrations);
  const rows = db
    .query(
      "SELECT org_id, value FROM settings WHERE scope_kind = 'org' AND key = 'approval_policy' ORDER BY org_id",
    )
    .all() as { org_id: string; value: string }[];
  expect(parsed(rows)).toEqual([...EXPECTED, { org_id: "o3", value: KEPT }]);
  expect(db.query("SELECT count(*) AS n FROM approval_policies").get()).toEqual({ n: 4 });
  db.run(
    "INSERT INTO events (public_id, org_id, type) VALUES ('e3', 'o1', 'approval.policy_loosened')",
  );
  expect(db.query("SELECT id FROM events WHERE public_id = 'e3'").get()).toEqual({ id: 3 });
});

test("postgres: each org's policies become one approval_policy setting, the table stays", async () => {
  const client = new PGlite();
  const orm = drizzle(client);
  try {
    const at = pgMigrations.findIndex((m) => m.tag.endsWith(TAG));
    expect(at).toBeGreaterThan(0);
    await applyPgMigrations(orm as never, pgMigrations.slice(0, at));
    await orm.execute(
      sql`insert into orgs (id, slug, name) values ('o1', 'one', 'One'), ('o2', 'two', 'Two')`,
    );
    for (const [org, env, required, author] of ROWS) {
      await orm.execute(
        sql`insert into approval_policies (org_id, environment, required, allow_author_approval, updated_by, updated_at) values (${org}, ${env}, ${required}, ${author}, 'cli', 1)`,
      );
    }
    await applyPgMigrations(orm as never, pgMigrations);
    const r = (await orm.execute(
      sql`select org_id, value from settings where scope_kind = 'org' and key = 'approval_policy' order by org_id`,
    )) as unknown as { rows: { org_id: string; value: string }[] };
    expect(parsed(r.rows)).toEqual(EXPECTED);
    const n = (await orm.execute(
      sql`select count(*)::int as n from approval_policies`,
    )) as unknown as { rows: unknown[] };
    expect(n.rows).toEqual([{ n: 3 }]);
  } finally {
    await client.close();
  }
});
