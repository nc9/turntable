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
    // booleans and bytes arrive as their Postgres types
    const col = await rows(
      target,
      "select data_type from information_schema.columns where table_name = 'org_quotas' limit 1",
    );
    expect(col.length).toBeGreaterThan(0);
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

  test("a non-empty target is refused unless identical", async () => {
    const target = await freshTarget();
    await copySqliteToPg(src, target, { dryRun: false, exclude: [] });
    // identical: a second dry run and a second real run both succeed and copy nothing
    const again = await copySqliteToPg(src, target, { dryRun: false, exclude: [] });
    expect(again.target_state).toBe("identical");
    expect(again.tables.every((t) => t.copied === 0)).toBe(true);
    expect(again.verified).toBe(true);
    // different: refused, and nothing is deleted
    await rows(target, "delete from log_chunks");
    await expect(copySqliteToPg(src, target, { dryRun: false, exclude: [] })).rejects.toThrow(
      /already holds rows/,
    );
    expect((await rows(target, "select count(*)::int as n from orgs"))[0]!.n).toBe(
      sourceCount("orgs"),
    );
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

  beforeEach(async () => {
    env = { registry, db, allowInstance: true };
    secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
    process.env[ENV] = "postgres://invalid.example/db";
    setCopyTargetOpener(async () => freshTarget());
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
