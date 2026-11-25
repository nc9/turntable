// The notifications migration adds `format` to outbound_webhook_endpoints (#611). An endpoint that
// exists before it must come out with format 'json' and keep its delivery rows, on both dialects.
// (The sqlite table rebuild once copied the missing column as the literal 'format'.)
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { applyMigrations } from "../src/db/migrate";
import { migrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";
import { applyPgMigrations } from "../src/db/pg";
import { createOutboundEndpoint } from "../src/db/repos/webhooks";
import type { WebhookFormat } from "../src/db/schema";
import { seedWorld } from "./ops-helpers";

const TAG = "_notifications";

test("sqlite: an existing endpoint gets format json and keeps its deliveries", () => {
  const db = new Database(":memory:");
  const at = migrations.findIndex((m) => m.tag.endsWith(TAG));
  expect(at).toBeGreaterThan(0);
  applyMigrations(db, migrations.slice(0, at));
  db.run("INSERT INTO orgs (id, slug, name) VALUES ('o1', 'one', 'One')");
  db.run(
    "INSERT INTO outbound_webhook_endpoints (id, org_id, url, created_by) VALUES ('ep1', 'o1', 'https://example.com/h', 'cli')",
  );
  db.run(
    "INSERT INTO outbound_webhook_deliveries (id, org_id, endpoint_id, event_id, next_attempt_at) VALUES ('d1', 'o1', 'ep1', 7, 1)",
  );
  applyMigrations(db, migrations);
  expect(db.query("SELECT id, format FROM outbound_webhook_endpoints").all()).toEqual([
    { id: "ep1", format: "json" },
  ]);
  expect(
    db.query("SELECT id, endpoint_id, event_id FROM outbound_webhook_deliveries").all(),
  ).toEqual([{ id: "d1", endpoint_id: "ep1", event_id: 7 }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("postgres: an existing endpoint gets format json and keeps its deliveries", async () => {
  const client = new PGlite();
  const orm = drizzle(client);
  try {
    const at = pgMigrations.findIndex((m) => m.tag.endsWith(TAG));
    expect(at).toBeGreaterThan(0);
    await applyPgMigrations(orm as never, pgMigrations.slice(0, at));
    await orm.execute(sql`insert into orgs (id, slug, name) values ('o1', 'one', 'One')`);
    await orm.execute(
      sql`insert into outbound_webhook_endpoints (id, org_id, url, created_by) values ('ep1', 'o1', 'https://example.com/h', 'cli')`,
    );
    await orm.execute(
      sql`insert into outbound_webhook_deliveries (id, org_id, endpoint_id, event_id, next_attempt_at) values ('d1', 'o1', 'ep1', 7, 1)`,
    );
    await applyPgMigrations(orm as never, pgMigrations);
    const e = (await orm.execute(
      sql`select id, format from outbound_webhook_endpoints`,
    )) as unknown as { rows: unknown[] };
    expect(e.rows).toEqual([{ id: "ep1", format: "json" }]);
    const d = (await orm.execute(
      sql`select id, endpoint_id from outbound_webhook_deliveries`,
    )) as unknown as { rows: unknown[] };
    expect(d.rows).toEqual([{ id: "d1", endpoint_id: "ep1" }]);
  } finally {
    await client.close();
  }
});

test("the write path refuses an unknown format (sqlite has no CHECK on the column)", async () => {
  const { db, a } = await seedWorld();
  await expect(
    createOutboundEndpoint(
      db,
      { orgId: a.scope.orgId },
      {
        url: "https://example.com/h",
        description: "",
        eventTypes: null,
        format: "xml" as unknown as WebhookFormat,
        createdBy: "test",
        fromStart: true,
        now: Date.now(),
      },
    ),
  ).rejects.toThrow("unknown webhook format: xml");
  const ok = await createOutboundEndpoint(
    db,
    { orgId: a.scope.orgId },
    {
      url: "https://example.com/h",
      description: "",
      eventTypes: null,
      format: "slack",
      createdBy: "test",
      fromStart: true,
      now: Date.now(),
    },
  );
  expect(ok.format).toBe("slack");
});
