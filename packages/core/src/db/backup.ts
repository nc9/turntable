// SQLite backups with `VACUUM INTO` (#280). The image is distroless, so the instance has to take
// its own copy before an upgrade. The target is never an input: it is always a fresh file named
// from the time and the binary version, under `<data-dir>/backups/`, and every step checks that
// it stays inside the data dir (no `..`, no symlinked backups directory).
//
// The copy runs on a worker thread (backup-worker.ts) so the event loop is never blocked.
// The backup reads through its own read-only connection. In WAL mode that sees one consistent
// snapshot of the committed rows, whatever another connection is writing meanwhile.
import { Database } from "bun:sqlite";
import { createReadStream, existsSync, statSync, statfsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BackupWorkerReply, BackupWorkerRequest } from "./backup-worker";
import { BUSY_TIMEOUT_MS } from "./sqlite-wal";
import { migrations } from "./migrations.generated";
import { DEFAULT_BACKUP_KEEP, settingsRegistry } from "../settings/definitions";
import {
  createSettingsRuntime,
  resolveSettingBeforeDb,
  type SettingsRuntime,
} from "../settings/resolve";

import {
  BACKUP_NAME_RE as NAME_RE,
  BACKUPS_DIR,
  backupFileName,
  backupPartialName,
  safePart,
} from "./backup-names";

export { BACKUPS_DIR };
export { DEFAULT_BACKUP_KEEP };
/** Free space required beside the backup, as a multiple of the database's size. */
export const BACKUP_SPACE_FACTOR = 2;

/** What the server tells `db_backup`: where the SQLite file is, or that this is Postgres. */
export type BackupConfig =
  | {
      dialect: "sqlite";
      dataDir: string;
      dbPath: string;
      keep: number;
      /** TEST ONLY: the server never sets it. See `BackupOptions.afterCopy`. */
      afterCopy?: (() => Promise<void>) | undefined;
    }
  | { dialect: "pg" };

export type BackupErrorCode = "unsupported" | "no_space" | "unsafe_path" | "failed";

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

export type BackupResult = {
  path: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  version: string;
  createdAt: number;
  /** Names of older backups removed to honour `keep`. */
  pruned: string[];
};

export type BackupOptions = {
  dbPath: string;
  dataDir: string;
  version: string;
  keep?: number | undefined;
  now?: (() => number) | undefined;
  /** Added to the file name (`pre-migrate`). Letters, digits and `-` only. */
  label?: string | undefined;
  /** Free bytes where the backup goes. Tests inject it; the default asks the filesystem. */
  freeBytes?: ((dir: string) => number) | undefined;
  /**
   * TEST ONLY. Awaited right after the copy, so a test can hold the backup "in progress" while
   * writers run (`VACUUM INTO` itself is synchronous and cannot be paused). Not in the op's input
   * schema and not set by the CLI or the server.
   */
  afterCopy?: (() => Promise<void>) | undefined;
  /** TEST ONLY: the worker blocks this long after the copy, to stand in for a large database. */
  workerHoldMs?: number | undefined;
};

export const PG_BACKUP_MESSAGE =
  "db_backup only supports the SQLite database. This instance runs on Postgres: take the backup " +
  "with pg_dump (or your platform's snapshot) instead.";

/** True when `child` is `parent` or lies inside it, by path alone. */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Creates `<dataDir>/backups` and proves it is a real directory inside the data dir. */
async function backupsDir(dataDir: string): Promise<string> {
  const root = resolve(dataDir);
  const dir = join(root, BACKUPS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new BackupError("unsafe_path", `${dir} must be a plain directory, not a link`);
  }
  if (!inside(await realpath(root), await realpath(dir))) {
    throw new BackupError("unsafe_path", "the backups directory resolves outside the data dir");
  }
  return dir;
}

function dbBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += statSync(dbPath + suffix).size;
    } catch {
      // no -wal file: nothing uncheckpointed
    }
  }
  return total;
}

function defaultFree(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Lists backups, oldest first. Only files this module names; anything else in the dir is left. */
export async function listBackups(dataDir: string): Promise<string[]> {
  const dir = join(resolve(dataDir), BACKUPS_DIR);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((n) => NAME_RE.test(n)).sort();
}

/**
 * Where the worker's code is. From source it is the file beside this one. In the compiled binary
 * it is an entrypoint embedded in the executable (scripts/build.ts builds with `root` set to the
 * repo root), so nothing is read from disk and the binary works from an empty directory.
 */
function workerEntry(): string | URL {
  return import.meta.url.includes("/$bunfs/") || import.meta.url.includes("B:/~BUN")
    ? "./packages/core/src/db/backup-worker.ts"
    : new URL("./backup-worker.ts", import.meta.url);
}

/** Runs `VACUUM INTO` on a worker thread; the main thread only waits for the reply. */
function copyInWorker(req: BackupWorkerRequest): Promise<void> {
  return new Promise<void>((resolveCopy, reject) => {
    const worker = new Worker(workerEntry());
    const done = (err?: Error): void => {
      void worker.terminate();
      if (err) reject(err);
      else resolveCopy();
    };
    worker.onmessage = (event: MessageEvent<BackupWorkerReply>) =>
      done(event.data.ok ? undefined : new Error(event.data.message));
    worker.onerror = (event) => done(new Error(event.message || "the backup worker crashed"));
    worker.postMessage(req);
  });
}

export async function backupSqlite(opts: BackupOptions): Promise<BackupResult> {
  const keep = opts.keep ?? DEFAULT_BACKUP_KEEP;
  if (!Number.isInteger(keep) || keep < 1 || keep > 10_000) {
    throw new BackupError("failed", "keep must be a whole number from 1 to 10000");
  }
  const dataDir = resolve(opts.dataDir);
  const dbPath = resolve(opts.dbPath);
  if (!inside(dataDir, dbPath) || !existsSync(dbPath)) {
    throw new BackupError("failed", "the database file is not in the data dir");
  }
  const dir = await backupsDir(dataDir);
  const size = dbBytes(dbPath);
  const free = (opts.freeBytes ?? defaultFree)(dir);
  if (free < size * BACKUP_SPACE_FACTOR) {
    throw new BackupError(
      "no_space",
      `not enough free space for a backup: ${free} bytes free, ${size * BACKUP_SPACE_FACTOR} needed (twice the database size)`,
    );
  }
  const createdAt = (opts.now ?? Date.now)();
  const version = safePart(opts.version, "unknown");
  const name = backupFileName(createdAt, opts.version, opts.label);
  const finalPath = join(dir, name);
  const partial = join(dir, backupPartialName(name));
  if (!NAME_RE.test(name) || !inside(dir, finalPath) || existsSync(finalPath)) {
    throw new BackupError("failed", `refusing to write ${name}`);
  }
  await rm(partial, { force: true });
  try {
    await copyInWorker({
      dbPath,
      partial,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      holdMs: opts.workerHoldMs,
    });
    await opts.afterCopy?.();
    await chmod(partial, 0o600);
    // The copy must open and be sound before it is trusted as a backup.
    const check = new Database(partial, { readonly: true, strict: true });
    try {
      const row = check.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      if (row?.quick_check !== "ok") throw new Error("the backup failed its integrity check");
    } finally {
      check.close();
    }
    await rename(partial, finalPath);
  } catch (err) {
    await rm(partial, { force: true });
    if (err instanceof BackupError) throw err;
    throw new BackupError("failed", `backup failed: ${(err as Error).message}`);
  }
  const sizeBytes = statSync(finalPath).size;
  const sha256 = await sha256Of(finalPath);
  const pruned: string[] = [];
  const all = await listBackups(dataDir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    if (old === name) continue;
    await rm(join(dir, old), { force: true });
    pruned.push(old);
  }
  return { path: finalPath, name, sizeBytes, sha256, version, createdAt, pruned };
}

/** Migration tags the binary ships that the database has not recorded yet. */
export function pendingMigrations(dbPath: string): string[] {
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) return [];
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('__turntable_migrations', '__longshore_migrations')", // rename-keep: the legacy table name
      )
      .all()
      .map((r) => r.name);
    // Two tables is a refusal the migrator reports; it is not for the backup to guess.
    const table = tables.length === 1 ? tables[0] : undefined;
    const done = new Set(
      table
        ? db
            .query<{ tag: string }, []>(`SELECT tag FROM ${table}`)
            .all()
            .map((r) => r.tag)
        : [],
    );
    return migrations.map((m) => m.tag).filter((t) => !done.has(t));
  } finally {
    db.close();
  }
}

/**
 * `TURNTABLE_BACKUP_BEFORE_MIGRATE=1`: called before the database is opened for the new binary.
 * When migrations are pending on an existing database, takes a backup first. A failed backup
 * stops the boot: the operator asked for the safety net, so the migration must not run without it.
 */
export async function backupBeforeMigrate(
  opts: Omit<BackupOptions, "label"> & { log?: (m: string) => void },
): Promise<BackupResult | undefined> {
  const pending = pendingMigrations(opts.dbPath);
  if (pending.length === 0) return undefined;
  const result = await backupSqlite({ ...opts, label: "pre-migrate" });
  opts.log?.(
    `${pending.length} migration(s) pending; backed up the database to ${result.path} (sha256 ${result.sha256})`,
  );
  return result;
}

/**
 * How many backups to keep, before the database is open: the environment (`TURNTABLE_BACKUP_KEEP`),
 * then `turntable.toml`, then the default. A value that is not a whole number from 1 to 10000 is
 * refused, naming where it was set. The database layer is read by `db_backup` itself.
 */
export function backupKeepFromEnv(
  env: Record<string, string | undefined>,
  settings: SettingsRuntime = createSettingsRuntime(settingsRegistry, env),
): number {
  return resolveSettingBeforeDb(settings, "backup_keep").value as number;
}
