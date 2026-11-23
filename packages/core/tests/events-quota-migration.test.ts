import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";

/** The schema one migration before the one that adds quota.* to the event types, with events. */
function before(): Database {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const last = migrations.findIndex((m) => m.tag.endsWith("_quota_events"));
  expect(last).toBeGreaterThan(0);
  applyMigrations(sqlite, migrations.slice(0, last));
  sqlite.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'acme', 'Acme')");
  const ev = (pid: string, type: string, payload: string) =>
    sqlite.run("INSERT INTO events (public_id, org_id, type, payload) VALUES (?, 'o1', ?, ?)", [
      pid,
      type,
      payload,
    ]);
  ev("e1", "run.queued", "{}");
  ev(
    "e2",
    "infra.error",
    '{"error_class":"quota_warning","metric":"runs_per_hour","used":8,"limit":10}',
  );
  ev(
    "e3",
    "infra.error",
    '{"error_class":"quota_reached","metric":"runs_per_hour","used":10,"limit":10}',
  );
  ev("e4", "infra.error", '{"error_class":"sandbox_create_failed"}');
  // a later event that was pruned: the AUTOINCREMENT high-water mark stays above the last row
  ev("e5", "run.queued", "{}");
  sqlite.run("DELETE FROM events WHERE public_id = 'e5'");
  return sqlite;
}

test("the type list is widened, old quota notices become quota.*, real infra errors stay", () => {
  const sqlite = before();
  applyMigrations(sqlite, migrations);
  const rows = sqlite
    .query("SELECT public_id AS id, type, payload FROM events ORDER BY id")
    .all() as { id: string; type: string; payload: string }[];
  expect(rows.map((r) => [r.id, r.type])).toEqual([
    ["e1", "run.queued"],
    ["e2", "quota.warning"],
    ["e3", "quota.reached"],
    ["e4", "infra.error"],
  ]);
  expect(JSON.parse(rows[1]!.payload)).toEqual({ metric: "runs_per_hour", used: 8, limit: 10 });
  expect(JSON.parse(rows[3]!.payload)).toEqual({ error_class: "sandbox_create_failed" });
  // the new types are accepted (the type is validated in code now, not by a CHECK)
  sqlite.run("INSERT INTO events (public_id, org_id, type) VALUES ('n1', 'o1', 'quota.reached')");
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a feed cursor never meets a reused id: the sequence survives the rebuild", () => {
  const sqlite = before();
  applyMigrations(sqlite, migrations);
  sqlite.run("INSERT INTO events (public_id, org_id, type) VALUES ('n1', 'o1', 'run.queued')");
  const id = (sqlite.query("SELECT id FROM events WHERE public_id = 'n1'").get() as { id: number })
    .id;
  expect(id).toBeGreaterThan(5);
});
