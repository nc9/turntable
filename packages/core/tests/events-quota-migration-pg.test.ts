import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrations } from "../src/db/migrations.pg.generated";
import { applyPgMigrations } from "../src/db/pg";

// The Postgres side of events-quota-migration.test.ts: the CHECK constraint is widened to the
// quota.* types and old quota notices (infra.error with an error_class) become quota.* events.
async function open() {
  const client = new PGlite();
  const orm = drizzle(client);
  const last = migrations.findIndex((m) => m.tag.endsWith("_quota_events"));
  expect(last).toBeGreaterThan(0);
  await applyPgMigrations(orm as never, migrations.slice(0, last));
  await orm.execute(sql`insert into orgs (id, slug, name) values ('o1', 'acme', 'Acme')`);
  const ev = (pid: string, type: string, payload: string) =>
    orm.execute(
      sql`insert into events (public_id, org_id, type, payload) values (${pid}, 'o1', ${type}, ${payload})`,
    );
  await ev("e1", "run.queued", "{}");
  await ev(
    "e2",
    "infra.error",
    '{"error_class":"quota_warning","metric":"runs_per_hour","used":8,"limit":10}',
  );
  await ev(
    "e3",
    "infra.error",
    '{"error_class":"quota_reached","metric":"runs_per_hour","used":10,"limit":10}',
  );
  await ev("e4", "infra.error", '{"error_class":"sandbox_create_failed"}');
  return { client, orm };
}

const rowsOf = async (orm: ReturnType<typeof drizzle>, q: ReturnType<typeof sql>) => {
  const r = (await orm.execute(q)) as unknown as { rows: Record<string, unknown>[] };
  return r.rows;
};

test("the type list is widened, old quota notices become quota.*, real infra errors stay", async () => {
  const { client, orm } = await open();
  try {
    await applyPgMigrations(orm as never, migrations);
    const rows = await rowsOf(
      orm,
      sql`select public_id as id, type, payload from events order by public_id`,
    );
    expect(rows.map((r) => [r.id, r.type])).toEqual([
      ["e1", "run.queued"],
      ["e2", "quota.warning"],
      ["e3", "quota.reached"],
      ["e4", "infra.error"],
    ]);
    expect(JSON.parse(rows[1]!.payload as string)).toEqual({
      metric: "runs_per_hour",
      used: 8,
      limit: 10,
    });
    expect(JSON.parse(rows[3]!.payload as string)).toEqual({
      error_class: "sandbox_create_failed",
    });
    // the new types are accepted, an unknown one still is not
    await orm.execute(
      sql`insert into events (public_id, org_id, type) values ('n1', 'o1', 'quota.reached')`,
    );
    const bad = async () => {
      await orm.execute(
        sql`insert into events (public_id, org_id, type) values ('n2', 'o1', 'quota.other')`,
      );
    };
    await expect(bad()).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test("applying the migration twice does nothing the second time", async () => {
  const { client, orm } = await open();
  try {
    expect(
      (await applyPgMigrations(orm as never, migrations)).some((t) => t.endsWith("_quota_events")),
    ).toBe(true);
    expect(await applyPgMigrations(orm as never, migrations)).toEqual([]);
  } finally {
    await client.close();
  }
});
