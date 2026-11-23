// `openReadOnly` (the handle `turntable doctor` reads through) cannot write, on SQLite, on PGlite
// and on a real Postgres: whichever the suite is pointed at (TURNTABLE_TEST_DB).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIALECT, testDb } from "../src/db/dialect";
import { openDatabase, type Db } from "../src/db";
import { sqlState } from "../src/db/errors";
import { openReadOnly, embeddedMigrationTags } from "../src/db/read-only";
import { openPostgres, type PgTarget } from "../src/db/pg";
import { checkDatabase } from "../src/doctor/checks";
import { readerOf } from "../src/doctor/real";
import type { DoctorInputs } from "../src/doctor/types";

type Raw = { run?(q: SQL): unknown; execute?(q: SQL): Promise<unknown> };
const exec = async (orm: unknown, q: SQL): Promise<void> => {
  const o = orm as Raw;
  await (DIALECT === "pg" ? o.execute!(q) : o.run!(q));
};

let dir: string;
let path: string;
let target: PgTarget | undefined;
let seed: Db;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "tt-ro-"));
  path = join(dir, "turntable.db");
  const t = testDb();
  if (DIALECT === "pg") {
    // a real server: a schema of its own; PGlite: the shared in-process database
    target =
      t && t !== "pglite" ? { url: t, schema: `lstest_ro_${process.pid}` } : { pglite: true };
    seed = openPostgres(target, { fresh: true });
  } else {
    seed = openDatabase(path);
  }
  // The database as a server leaves it (migrated), plus a table to aim writes at.
  await seed.run((d) => exec(d.orm, sql`CREATE TABLE ro_probe (id integer)`));
  if (DIALECT !== "pg") seed.close();
});
afterEach(async () => {
  if (DIALECT === "pg") {
    const schema = target && "schema" in target ? target.schema : undefined;
    if (schema) {
      await seed.run((d) =>
        exec(d.orm, sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`),
      );
    }
    seed.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("INSERT, UPDATE and DDL through the handle fail; reads still work", async () => {
  const ro = openReadOnly(path, target);
  try {
    const rejected = async (q: SQL): Promise<unknown> => {
      try {
        await exec(ro.orm, q);
      } catch (e) {
        return e;
      }
      return undefined;
    };
    for (const q of [
      sql`INSERT INTO ro_probe (id) VALUES (1)`,
      sql`UPDATE ro_probe SET id = 2`,
      sql`CREATE TABLE ro_other (id integer)`,
      sql`DROP TABLE ro_probe`,
    ]) {
      const err = await rejected(q);
      expect(err).toBeDefined();
      if (DIALECT === "pg") expect(sqlState(err)).toBe("25006"); // read_only_sql_transaction
    }
    const read = ro.orm as { all?(q: SQL): unknown; execute?(q: SQL): Promise<unknown> };
    await (DIALECT === "pg"
      ? read.execute!(sql`SELECT count(*) FROM ro_probe`)
      : read.all!(sql`SELECT count(*) FROM ro_probe`));
  } finally {
    ro.close();
  }
});

test("doctor's database check passes through the read-only handle", async () => {
  const ro = openReadOnly(path, target);
  try {
    const checks = await checkDatabase({
      db: readerOf(ro),
      expectedMigrations: embeddedMigrationTags(),
    } as unknown as DoctorInputs);
    expect(checks.map((c) => c.status)).not.toContain("fail");
  } finally {
    ro.close();
  }
});
