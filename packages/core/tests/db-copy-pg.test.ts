// instance_db_copy (#716): SQLite to Postgres (PGlite here). Counts and key checksums, sequences,
// the audit chain on the target, excluded tables, FK order, non-empty targets, and the op's gates.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { Database } from "bun:sqlite";
import { appendAudit, appendEvent, type Db } from "../src/db";
import {
  type CopyTarget,
  copySqliteToPg,
  CopyRefused,
  fkOrder,
  setCopyTargetOpener,
} from "../src/db/copy-to-pg";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { processDrain, resetProcessDrain } from "../src/scheduler/drain";
import { onPostgres } from "./pg-mode";
import { addLog, seedWorld, type Tenant } from "./ops-helpers";

const require_ = createRequire(import.meta.url);
const pglite = "@electric-sql/pglite";
const drv = "drizzle-orm/pglite";

type Q = { query(t: string, p?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const opened: CopyTarget[] = [];

async function freshTarget(): Promise<CopyTarget> {
  const { PGlite } = require_(pglite) as { PGlite: new () => { close(): Promise<void> } };
  const { drizzle } = require_(drv) as { drizzle: (c: unknown) => unknown };
  const client = new PGlite();
  const t = { orm: drizzle(client), close: () => client.close() } as unknown as CopyTarget;
  opened.push(t);
  return t;
}
const rows = async (t: CopyTarget, text: string, p: unknown[] = []) =>
  (await (t.orm as unknown as { $client: Q }).$client.query(text, p)).rows;

let db: Db;
let a: Tenant;
let b: Tenant;
let src: Database;

const sqliteDescribe = onPostgres ? describe.skip : describe;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  src = (db.orm as unknown as { $client: Database }).$client;
  for (const t of [a, b]) {
    for (let i = 0; i < 3; i++) {
      await appendAudit(
        db,
        { orgId: t.orgId },
        {
          principalKind: "member",
          principalId: "m",
          op: "x",
          effect: "write",
          outcome: "ok",
          input: { i },
        },
      );
    }
    await appendEvent(db, t.scope, { type: "run.queued", payload: {} } as never).catch(() => {});
    await addLog(db, t, "hello\nworld\n");
  }
});
afterEach(async () => {
  for (const t of opened.splice(0)) await t.close().catch(() => {});
  setCopyTargetOpener(undefined);
  resetProcessDrain();
});

const sourceCount = (t: string): number =>
  (src.query(`select count(*) as n from "${t}"`).get() as { n: number }).n;

sqliteDescribe("copySqliteToPg", () => {
  test("dry run reports counts, migrates the target and copies nothing", async () => {
    const target = await freshTarget();
    const r = await copySqliteToPg(src, target, { dryRun: true, exclude: [] });
    expect(r.dry_run).toBe(true);
    expect(r.target_state).toBe("empty");
    expect(r.migrations_applied.length).toBeGreaterThan(0);
    const orgs = r.tables.find((t) => t.table === "orgs")!;
    expect(orgs.source_rows).toBe(sourceCount("orgs"));
    expect(orgs.copied).toBe(0);
    expect((await rows(target, "select count(*)::int as n from orgs"))[0]!.n).toBe(0);
  });

  test("real run: counts and key checksums equal, sequences continue, audit chain verifies", async () => {
    const maxEvent = (src.query("select max(id) as m from events").get() as { m: number }).m;
    expect(maxEvent).toBeGreaterThan(0);
    const target = await freshTarget();
    const r = await copySqliteToPg(src, target, { dryRun: false, exclude: [] });
    expect(r.verified).toBe(true);
    for (const t of r.tables) {
      expect(t.copied).toBe(t.source_rows);
      expect(
        Number((await rows(target, `select count(*)::int as n from "${t.table}"`))[0]!.n),
      ).toBe(sourceCount(t.table));
    }
    expect(r.audit).toMatchObject({ orgs: 2 });
    expect(r.audit!.entries).toBeGreaterThanOrEqual(6);
    // a new event id on the target is above every copied one
    const [n] = await rows(
      target,
      `insert into events (public_id, org_id, type) values ('new-evt', $1, 'x') returning id`,
      [a.orgId],
    );
    expect(Number(n!.id)).toBeGreaterThan(maxEvent);
    // booleans and bytes arrive as their Postgres types, with the source's values
    const want = (src.query("select local from runs order by id").all() as { local: number }[]).map(
      (r) => r.local === 1,
    );
    expect(want.length).toBeGreaterThan(0);
    const got = await rows(target, "select local from runs order by id");
    expect(got.map((r) => r.local)).toEqual(want);
    const chunks = src.query("select bytes from log_chunks order by attempt_id, offset").all() as {
      bytes: Uint8Array;
    }[];
    expect(chunks.length).toBeGreaterThan(0);
    const back = await rows(target, 'select bytes from log_chunks order by attempt_id, "offset"');
    expect(back.map((r) => Buffer.from(r.bytes as Uint8Array).toString("hex"))).toEqual(
      chunks.map((r) => Buffer.from(r.bytes).toString("hex")),
    );
  });

  test("the SQLite source is not modified", async () => {
    const dump = () =>
      JSON.stringify(src.query("select * from audit_log order by id").all()) + sourceCount("orgs");
    const before = dump();
    const version = (src.query("pragma data_version").get() as { data_version: number })
      .data_version;
    await copySqliteToPg(src, await freshTarget(), { dryRun: false, exclude: [] });
    expect(dump()).toBe(before);
    expect((src.query("pragma data_version").get() as { data_version: number }).data_version).toBe(
      version,
    );
  });

  test("excluded tables are skipped", async () => {
    expect(sourceCount("log_chunks")).toBeGreaterThan(0);
    const target = await freshTarget();
    const r = await copySqliteToPg(src, target, {
      dryRun: false,
      exclude: ["log_chunks", "log_cuts", "log_notices"],
    });
    expect(r.tables.map((t) => t.table)).not.toContain("log_chunks");
    expect(r.excluded).toEqual(["log_chunks", "log_cuts", "log_notices"]);
    expect((await rows(target, "select count(*)::int as n from log_chunks"))[0]!.n).toBe(0);
    await expect(
      copySqliteToPg(src, await freshTarget(), { dryRun: true, exclude: ["nope"] }),
    ).rejects.toThrow(CopyRefused);
  });

  test("foreign-key order: parents come before children", () => {
    const order = fkOrder(
      src,
      (
        src
          .query(
            "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\'",
          )
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const pos = new Map(order.map((t, i) => [t, i] as const));
    for (const t of order) {
      for (const f of src.query(`pragma foreign_key_list("${t}")`).all() as { table: string }[]) {
        if (f.table !== t) expect(pos.get(f.table)!).toBeLessThan(pos.get(t)!);
      }
    }
    // a child of an excluded parent is refused
    expect(() => fkOrder(src, ["jobs"])).toThrow(CopyRefused);
  });

  test("a non-empty target is refused, before it is migrated and with nothing deleted", async () => {
    const target = await freshTarget();
    await copySqliteToPg(src, target, { dryRun: false, exclude: [] });
    // a second run, real or dry, is refused: a key checksum cannot see changed contents
    for (const dryRun of [true, false]) {
      await expect(copySqliteToPg(src, target, { dryRun, exclude: [] })).rejects.toThrow(
        /already holds rows/,
      );
    }
    // the same keys with stale contents (the case an "identical" check would have accepted)
    src.run("update orgs set name = 'renamed' where id = ?", [a.orgId]);
    await expect(copySqliteToPg(src, target, { dryRun: false, exclude: [] })).rejects.toThrow(
      /already holds rows/,
    );
    expect((await rows(target, "select count(*)::int as n from orgs"))[0]!.n).toBe(
      sourceCount("orgs"),
    );
    // refused before migrating: a database with rows and no migration bookkeeping stays as it is
    const bare = await freshTarget();
    await rows(bare, "create table orgs (id text primary key)");
    await rows(bare, "insert into orgs values ('x')");
    await expect(copySqliteToPg(src, bare, { dryRun: true, exclude: [] })).rejects.toThrow(
      /already holds rows/,
    );
    const tables = await rows(
      bare,
      "select table_name from information_schema.tables where table_schema = current_schema()",
    );
    expect(tables.map((r) => r.table_name)).toEqual(["orgs"]);
  });

  test("a tampered audit row is caught on the target", async () => {
    // break the source chain: the copy copies it faithfully and the target walk refuses
    src.run("update audit_log set outcome = 'tampered' where seq = 2 and org_id = ?", [a.orgId]);
    const target = await freshTarget();
    await expect(copySqliteToPg(src, target, { dryRun: false, exclude: [] })).rejects.toThrow(
      /audit chain/,
    );
    // and the failed copy left the target empty
    expect((await rows(target, "select count(*)::int as n from orgs"))[0]!.n).toBe(0);
  });
});

sqliteDescribe("instance_db_copy op", () => {
  let env: DispatchEnv;
  let secret: string;
  const call = (input: Record<string, unknown>, token = secret) =>
    dispatch(env, { kind: "bearer", token }, "instance_db_copy", input);
  const ENV = "TURNTABLE_COPY_TARGET_URL";
  let lastTarget: CopyTarget;

  beforeEach(async () => {
    env = { registry, db, allowInstance: true };
    secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
    process.env[ENV] = "postgres://invalid.example/db";
    setCopyTargetOpener(async () => {
      // the op closes what it opens: keep the handle readable (the file's afterEach closes it)
      lastTarget = await freshTarget();
      return { orm: lastTarget.orm, close: async () => {} };
    });
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  test("a real run is refused unless drained; a dry run is not", async () => {
    const refused = await call({ target_url_env: ENV, dry_run: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("conflict");
    const dry = await call({ target_url_env: ENV, dry_run: true });
    expect(dry.ok).toBe(true);
    processDrain.set(true, "copy test", Date.now());
    const real = await call({
      target_url_env: ENV,
      dry_run: false,
      exclude_tables: ["log_chunks"],
    });
    expect(real.ok).toBe(true);
    if (real.ok) expect((real.output as { verified: boolean }).verified).toBe(true);
    // the op's own audit entry was written before the copy, so it is on the target too
    const onTarget = await rows(
      lastTarget,
      "select outcome from audit_log where op = 'instance_db_copy'",
    );
    expect(onTarget.map((r) => r.outcome)).toContain("started");
  });

  test("it is audited, and the URL is never in the output or the audit", async () => {
    const r = await call({ target_url_env: ENV, dry_run: true });
    expect(JSON.stringify(r)).not.toContain("invalid.example");
    const logged = JSON.stringify(
      src.query("select * from audit_log where op = 'instance_db_copy'").all(),
    );
    expect(logged).toContain("instance_db_copy");
    expect(logged).not.toContain("invalid.example");
  });

  test("instance administrators only; the variable name is restricted", async () => {
    const member = await call({ target_url_env: ENV, dry_run: true }, "not-a-token");
    expect(member.ok).toBe(false);
    for (const name of ["TURNTABLE_DATABASE_URL", "TURNTABLE_MASTER_KEY", "HOME"]) {
      const r = await call({ target_url_env: name, dry_run: true });
      expect(r.ok).toBe(false);
    }
    const { mcpTools } = await import("../src/ops/mcp");
    expect(JSON.stringify(mcpTools(registry))).not.toContain("instance_db_copy");
  });
});

describe("poolSettings", () => {
  const keys = [
    "TURNTABLE_PG_POOL_MAX",
    "TURNTABLE_PG_STATEMENT_TIMEOUT_MS",
    "TURNTABLE_PG_REQUIRE_TLS",
  ];
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });
  test("bounded pool, optional statement timeout, TLS demanded on request", async () => {
    const { poolSettings } = await import("../src/db/pg");
    expect(poolSettings("postgres://h/db")).toEqual({ max: 10 });
    process.env.TURNTABLE_PG_POOL_MAX = "5";
    process.env.TURNTABLE_PG_STATEMENT_TIMEOUT_MS = "30000";
    expect(poolSettings("postgres://h/db")).toEqual({
      max: 5,
      connection: { statement_timeout: 30000 },
    });
    process.env.TURNTABLE_PG_POOL_MAX = "0";
    expect(() => poolSettings("postgres://h/db")).toThrow(/TURNTABLE_PG_POOL_MAX/);
    process.env.TURNTABLE_PG_POOL_MAX = "5";
    process.env.TURNTABLE_PG_REQUIRE_TLS = "1";
    expect(() => poolSettings("postgres://h/db")).toThrow(/sslmode/);
    expect(() => poolSettings("postgres://h/db?sslmode=disable")).toThrow(/sslmode/);
    expect(poolSettings("postgres://h/db?sslmode=require").max).toBe(5);
  });
});
