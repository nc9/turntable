// `db_backup` (#280): a consistent SQLite backup the instance takes itself, instance
// administrator only, audited, pruned, refused on Postgres, and never written outside the data dir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { systemOrgId } from "../src/audit/failures";
import { type Db, listAudit, openDatabase } from "../src/db";
import {
  BackupError,
  backupBeforeMigrate,
  backupKeepFromEnv,
  backupSqlite,
  listBackups,
  pendingMigrations,
} from "../src/db/backup";
import { dbCommand } from "../src/db/cli";
import { DIALECT } from "../src/db/dialect";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { buildOpenApi } from "../src/ops/openapi";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken, seedTenant } from "./ops-helpers";

// The backup is a SQLite feature: the Postgres run of the suite has nothing to open.
const sqliteOnly = DIALECT === "sqlite" ? describe : describe.skip;

let dir: string;
let dbPath: string;
let db: Db;
let secret: string;
let clock: number;

const env = (over: Partial<DispatchEnv> = {}): DispatchEnv => ({
  registry,
  db,
  allowInstance: true,
  now: () => clock++,
  backup: { dialect: "sqlite", dataDir: dir, dbPath, keep: 10 },
  ...over,
});
const call = (input: Record<string, unknown> = {}, e: DispatchEnv = env()) =>
  dispatch(e, { kind: "bearer", token: secret }, "db_backup", input);

beforeEach(async () => {
  clock = Date.UTC(2026, 0, 2, 3, 4, 5);
  dir = mkdtempSync(join(tmpdir(), "tt-backup-"));
  dbPath = join(dir, "turntable.db");
  db = openDatabase(dbPath);
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

sqliteOnly("the backup", () => {
  test("a write in flight: the copy opens cleanly and holds every committed row, none uncommitted", async () => {
    const w = new Database(dbPath);
    w.run("PRAGMA busy_timeout = 5000");
    w.run("CREATE TABLE probe (n INTEGER PRIMARY KEY)");
    for (let n = 0; n < 200; n++) w.run("INSERT INTO probe VALUES (?)", [n]);
    w.run("BEGIN IMMEDIATE");
    for (let n = 200; n < 260; n++) w.run("INSERT INTO probe VALUES (?)", [n]);
    try {
      const r = await backupSqlite({ dbPath, dataDir: dir, version: "1.2.3", now: () => clock });
      w.run("COMMIT");
      const copy = new Database(r.path, { readonly: true });
      expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(copy.query("SELECT count(*) AS n FROM probe").get()).toEqual({ n: 200 });
      // The migrations ran too: it is a whole database, not a table dump.
      expect(
        copy.query<{ n: number }, []>("SELECT count(*) AS n FROM __turntable_migrations").get()!.n,
      ).toBeGreaterThan(0);
      copy.close();
    } finally {
      w.close();
    }
  });

  test("returns the path, size and sha256 of a file named with the time and version", async () => {
    const r = await backupSqlite({ dbPath, dataDir: dir, version: "1.2.3", now: () => clock });
    expect(r.path).toBe(join(dir, "backups", r.name));
    expect(r.name).toBe("turntable-20260102T030405000Z-1.2.3.db");
    expect(r.sizeBytes).toBe(readFileSync(r.path).length);
    expect(r.sha256).toBe(createHash("sha256").update(readFileSync(r.path)).digest("hex"));
    expect(await readdir(join(dir, "backups"))).toEqual([r.name]); // no partial file left
  });

  test("retention keeps the newest N and prunes the oldest, and leaves other files alone", async () => {
    writeFileSync(join(dir, "backups-note.txt"), "x");
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      clock += 1000;
      const r = await backupSqlite({
        dbPath,
        dataDir: dir,
        version: "1.0.0",
        keep: 2,
        now: () => clock,
      });
      names.push(r.name);
      if (i === 3) expect(r.pruned).toEqual([names[1]!]);
    }
    expect(await listBackups(dir)).toEqual([names[2]!, names[3]!]);
    expect(existsSync(join(dir, "backups-note.txt"))).toBe(true);
  });

  test("refuses when free space is below twice the database size", async () => {
    const err = await backupSqlite({
      dbPath,
      dataDir: dir,
      version: "1",
      freeBytes: () => 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).code).toBe("no_space");
    expect(await listBackups(dir)).toEqual([]);
  });

  test("a path escape is rejected: a symlinked backups dir, a database outside the data dir, a hostile version", async () => {
    const outside = mkdtempSync(join(tmpdir(), "tt-outside-"));
    try {
      symlinkSync(outside, join(dir, "backups"));
      const linked = await backupSqlite({ dbPath, dataDir: dir, version: "1" }).catch(
        (e: unknown) => e,
      );
      expect((linked as BackupError).code).toBe("unsafe_path");
      expect(await readdir(outside)).toEqual([]);
      rmSync(join(dir, "backups"));

      const stray = join(outside, "other.db");
      writeFileSync(stray, "");
      const elsewhere = await backupSqlite({ dbPath: stray, dataDir: dir, version: "1" }).catch(
        (e: unknown) => e,
      );
      expect(elsewhere).toBeInstanceOf(BackupError);

      const r = await backupSqlite({ dbPath, dataDir: dir, version: "../../../evil/x" });
      expect(r.path.startsWith(join(dir, "backups") + "/")).toBe(true);
      expect(r.name.includes("/")).toBe(false);
      expect(await readdir(outside)).toEqual(["other.db"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the op takes no path: an input that names one is refused", async () => {
    const r = await call({ path: "/tmp/x.db" });
    expect(r.ok).toBe(false);
    expect(await listBackups(dir)).toEqual([]);
  });
});

sqliteOnly("the operation", () => {
  test("the instance administrator gets the backup, and an audit row lands in the system chain", async () => {
    const r = await call({ keep: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { path: string; size_bytes: number; sha256: string; name: string };
    expect(existsSync(out.path)).toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 20 });
    const row = rows.find((x) => x.op === "db_backup");
    expect(row).toMatchObject({ outcome: "ok", effect: "write", principalKind: "instance" });
    expect(JSON.parse(row!.input)).toEqual({
      keep: 3,
      name: out.name,
      size_bytes: out.size_bytes,
      sha256: out.sha256,
    });
  });

  test("a failed backup is audited as an error, and the audit write is its own transaction", async () => {
    const r = await call(
      {},
      env({ backup: { dialect: "sqlite", dataDir: dir, dbPath: join(dir, "nope.db"), keep: 10 } }),
    );
    expect(r.ok).toBe(false);
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 20 });
    expect(rows.find((x) => x.op === "db_backup")?.outcome).toBe("error:internal");
  });

  test("a slow backup does not fail concurrent writers, in or out of process", async () => {
    const seed = new Database(dbPath);
    seed.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB)");
    seed.run("CREATE TABLE probe_w (id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT)");
    seed.run("INSERT INTO blobs (b) VALUES (randomblob(1048576))");
    seed.close();

    // A writer with its own connection, as another process would be, inserting in a loop.
    const src = `
      import { Database } from "bun:sqlite";
      const d = new Database(${JSON.stringify(dbPath)});
      d.run("PRAGMA busy_timeout = 10000");
      let ok = 0, failed = 0, maxMs = 0;
      self.onmessage = () => { self.postMessage({ ok, failed, maxMs }); close(); };
      const loop = () => {
        const t = performance.now();
        try { d.run("INSERT INTO probe_w (who) VALUES ('worker')"); ok++; } catch { failed++; }
        maxMs = Math.max(maxMs, performance.now() - t);
        setTimeout(loop, 1);
      };
      loop();
    `;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url);
    let inProcess = 0;
    let inProcessFailed = 0;
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        try {
          await db.transaction(async (tx) => {
            await (tx.orm as unknown as { run(q: unknown): unknown }).run(
              sql`INSERT INTO probe_w (who) VALUES ('main')`,
            );
          });
          inProcess++;
        } catch {
          inProcessFailed++;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    const started = performance.now();
    // The copy of this small file is instant, so the hook holds the backup in progress instead.
    const hold = (): Promise<void> => new Promise((done) => setTimeout(done, 1500));
    const r = await call(
      {},
      env({ backup: { dialect: "sqlite", dataDir: dir, dbPath, keep: 10, afterCopy: hold } }),
    );
    const took = performance.now() - started;
    stop = true;
    await loop;
    const counts = await new Promise<{ ok: number; failed: number; maxMs: number }>((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage("done");
    });
    expect(r.ok).toBe(true);
    expect(took).toBeGreaterThan(1000);
    expect(inProcessFailed).toBe(0);
    expect(inProcess).toBeGreaterThan(0);
    expect(counts.failed).toBe(0);
    expect(counts.ok).toBeGreaterThan(0);
    // No writer waited out the copy: the old write-transaction wrapper held them for all of it.
    expect(counts.maxMs).toBeLessThan(took / 2);
    if (!r.ok) return;
    const out = r.output as { path: string };
    const copy = new Database(out.path, { readonly: true });
    expect(copy.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    copy.close();
  }, 120_000);

  test("no org token of any role, and no member, can take it; nothing is written", async () => {
    const t = await seedTenant(db, "org-a");
    for (const role of AGENT_ROLES) {
      const token = (await mintToken(db, { orgId: t.orgId }, role)).secret;
      const r = await dispatch(env(), { kind: "bearer", token }, "db_backup", {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    }
    const member = await dispatch(
      env(),
      {
        kind: "principal",
        principal: { kind: "member", id: "m", orgId: t.orgId, role: "owner" },
      },
      "db_backup",
      {},
    );
    expect(member.ok).toBe(false);
    // An instance token is not a credential on a surface that does not allow it (MCP).
    const viaMcp = await dispatch(
      env({ allowInstance: false }),
      { kind: "bearer", token: secret },
      "db_backup",
      {},
    );
    expect(viaMcp.ok).toBe(false);
    expect(await listBackups(dir)).toEqual([]);
  });

  test("it is a REST and OpenAPI operation and not an MCP tool", () => {
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("db_backup");
    const doc = buildOpenApi(registry, "test") as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.paths["/instance/db-backup"]?.post).toBeDefined();
  });

  test("on Postgres it refuses and points to pg_dump; unconfigured it is unavailable", async () => {
    const pg = await call({}, env({ backup: { dialect: "pg" } }));
    expect(pg.ok).toBe(false);
    if (!pg.ok) {
      expect(pg.error.code).toBe("invalid_input");
      expect(pg.error.message).toContain("pg_dump");
    }
    const none = await call({}, env({ backup: undefined }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("unavailable");
  });

  test("`turntable db backup` writes a backup and audits it as the local operator", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      expect(await dbCommand(["backup", "--data-dir", dir, "--keep", "1"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(await listBackups(dir)).toHaveLength(1);
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 20 });
    expect(rows.find((x) => x.op === "db_backup")).toMatchObject({
      principalKind: "cli",
      outcome: "ok",
    });
  });
});

sqliteOnly("before a migration", () => {
  test("pending migrations on an existing database are backed up first; an up-to-date one is not", async () => {
    expect(pendingMigrations(dbPath)).toEqual([]);
    expect(await backupBeforeMigrate({ dbPath, dataDir: dir, version: "9.9.9" })).toBeUndefined();

    const w = new Database(dbPath);
    const last = w
      .query<{ tag: string }, []>("SELECT tag FROM __turntable_migrations ORDER BY applied_at DESC")
      .all()[0]!.tag;
    w.run("DELETE FROM __turntable_migrations WHERE tag = ?", [last]);
    w.close();
    expect(pendingMigrations(dbPath)).toEqual([last]);
    const r = await backupBeforeMigrate({ dbPath, dataDir: dir, version: "9.9.9" });
    expect(r?.name).toMatch(/-9\.9\.9-pre-migrate\.db$/);
  });

  test("a fresh data dir has nothing to back up", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "tt-fresh-"));
    try {
      const p = join(fresh, "turntable.db");
      expect(pendingMigrations(p)).toEqual([]);
      expect(
        await backupBeforeMigrate({ dbPath: p, dataDir: fresh, version: "1" }),
      ).toBeUndefined();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("TURNTABLE_BACKUP_KEEP is a whole number or it is refused", () => {
    expect(backupKeepFromEnv({})).toBe(10);
    expect(backupKeepFromEnv({ TURNTABLE_BACKUP_KEEP: "3" })).toBe(3);
    expect(() => backupKeepFromEnv({ TURNTABLE_BACKUP_KEEP: "0" })).toThrow();
    expect(() => backupKeepFromEnv({ TURNTABLE_BACKUP_KEEP: "two" })).toThrow();
  });
});
