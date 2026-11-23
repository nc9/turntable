import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrations } from "../src/db/migrations.pg.generated";
import { applyPgMigrations } from "../src/db/pg";

// The Postgres side of migration-sequence-guard.test.ts, the same way: every migration applied in
// order to a database holding rows in each identity (auto-numbered) table, the newest rows pruned
// after each, and the next insert must get an id above the highest ever issued. A failure names
// the table and the migration.
type Orm = ReturnType<typeof drizzle>;
const rows = async (orm: Orm, q: ReturnType<typeof sql>) =>
  ((await orm.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;

const SEEDERS: Record<string, (orm: Orm, tag: string) => Promise<number>> = {
  events: async (orm, tag) =>
    Number(
      (
        await rows(
          orm,
          sql`insert into events (public_id, org_id, type) values (${tag}, 'o1', 'run.queued') returning id`,
        )
      )[0]!.id,
    ),
  cache_entries: async (orm, tag) =>
    Number(
      (
        await rows(
          orm,
          sql`insert into cache_entries (org_id, project_id, klass, ref_scope, key, version, created_at, used_at) values ('o1', 'p1', 'protected', 'main', ${tag}, 'v1', 1, 1) returning id`,
        )
      )[0]!.id,
    ),
};

const autoNumbered = async (orm: Orm): Promise<string[]> =>
  (
    await rows(
      orm,
      sql`select table_name from information_schema.columns where table_schema = current_schema() and (is_identity = 'YES' or column_default like 'nextval%') order by table_name`,
    )
  ).map((r) => String(r.table_name));

const has = async (orm: Orm, table: string): Promise<boolean> =>
  (
    await rows(
      orm,
      sql`select 1 from information_schema.tables where table_schema = current_schema() and table_name = ${table}`,
    )
  ).length > 0;

test("after every migration, no id of an auto-numbered table can be issued twice (Postgres)", async () => {
  const client = new PGlite();
  const orm = drizzle(client);
  try {
    const issued = new Map<string, number>();
    const checked = new Set<string>();
    let n = 0;
    for (let k = 0; k < migrations.length; k++) {
      const tag = migrations[k]!.tag;
      await applyPgMigrations(orm as never, migrations.slice(0, k + 1));
      if (await has(orm, "orgs")) {
        await orm.execute(
          sql`insert into orgs (id, slug, name) values ('o1', 'acme', 'Acme') on conflict do nothing`,
        );
      }
      if (await has(orm, "projects")) {
        await orm.execute(
          sql`insert into projects (id, org_id, slug, name) values ('p1', 'o1', 'app', 'App') on conflict do nothing`,
        );
      }
      for (const table of await autoNumbered(orm)) {
        const seed = SEEDERS[table];
        if (!seed) {
          throw new Error(
            `${tag}: ${table} is an auto-numbered table with no seeder in migration-sequence-pg.test.ts: add one, so its ids are guarded`,
          );
        }
        checked.add(table);
        if (!issued.has(table)) {
          for (let i = 0; i < 6; i++) issued.set(table, await seed(orm, `s${n++}`));
          await orm.execute(sql.raw(`delete from ${table} where id >= ${issued.get(table)! - 1}`));
        }
        const before = issued.get(table)!;
        const id = await seed(orm, `p${n++}`);
        if (id <= before) {
          throw new Error(
            `after ${tag}: ${table} handed out id ${id} again (the highest ever issued was ${before})`,
          );
        }
        issued.set(table, id);
        await orm.execute(sql.raw(`delete from ${table} where id >= ${id - 1}`));
      }
    }
    expect(checked.has("events")).toBe(true);
    expect([...checked].toSorted()).toEqual(await autoNumbered(orm));
  } finally {
    await client.close();
  }
}, 120_000);
