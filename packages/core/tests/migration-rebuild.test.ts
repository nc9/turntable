import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";

/** A database at the schema before the migration that rebuilds tables, with data in them. */
function seeded(): Database {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  applyMigrations(sqlite, migrations.slice(0, 3));
  sqlite.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'acme', 'Acme')");
  sqlite.run("INSERT INTO projects (id, org_id, slug, name) VALUES ('p1', 'o1', 'app', 'App')");
  sqlite.run(
    "INSERT INTO runs (id, org_id, project_id, workflow_path, event, ref) VALUES ('r1', 'o1', 'p1', 'w.yml', 'push', 'main')",
  );
  sqlite.run(
    "INSERT INTO jobs (id, org_id, project_id, run_id, job_key, name) VALUES ('j1', 'o1', 'p1', 'r1', 'b', 'b')",
  );
  sqlite.run(
    "INSERT INTO job_attempts (id, org_id, project_id, job_id, attempt, provider) VALUES ('a1', 'o1', 'p1', 'j1', 1, 'x')",
  );
  sqlite.run(
    "INSERT INTO log_chunks (org_id, project_id, attempt_id, offset, bytes) VALUES ('o1', 'p1', 'a1', 0, x'6869')",
  );
  return sqlite;
}

test("a table-rebuild migration keeps existing rows and their foreign keys", () => {
  const sqlite = seeded();
  const applied = applyMigrations(sqlite, migrations);
  expect(applied).toEqual(migrations.slice(3).map((m) => m.tag));

  // data survived, children still point at parents
  expect(sqlite.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 1 });
  expect(sqlite.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  expect(sqlite.query("SELECT count(*) AS n FROM job_attempts").get()).toEqual({ n: 1 });
  expect(sqlite.query("SELECT count(*) AS n FROM log_chunks").get()).toEqual({ n: 1 });
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

  // enforcement is back on, and the new state is accepted by the new CHECK
  expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(() =>
    sqlite.run(
      "INSERT INTO jobs (id, org_id, project_id, run_id, job_key, name) VALUES ('j9', 'o1', 'p1', 'nope', 'k', 'k')",
    ),
  ).toThrow();
  sqlite.run("UPDATE jobs SET state = 'skipped' WHERE id = 'j1'");
  expect(() => sqlite.run("UPDATE jobs SET state = 'bogus' WHERE id = 'j1'")).toThrow();
});

test("a migration that leaves a foreign key violation is rolled back", () => {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  applyMigrations(sqlite, migrations.slice(0, 2));
  const bad = {
    tag: "9999_bad",
    when: Date.now() + 1_000_000,
    statements: [
      "INSERT INTO projects (id, org_id, slug, name) VALUES ('p', 'missing-org', 's', 'n')",
    ],
  };
  expect(() => applyMigrations(sqlite, [...migrations.slice(0, 2), bad])).toThrow(/foreign key/);
  expect(sqlite.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
  expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});
