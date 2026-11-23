// `turntable db backup`: the instance operator's backup, on the host, against the data directory
// (like `token` and `quotas`). Local access to the data dir is the trust root, so there is no
// token. It writes the same file `db_backup` does and is audited in the system org's chain.
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { systemOrgId } from "../audit/failures";
import { VERSION } from "../version";
import { openDatabase } from ".";
import { appendAudit } from "./repos";
import {
  BackupError,
  backupKeepFromEnv,
  backupSqlite,
  PG_BACKUP_MESSAGE,
  type BackupResult,
} from "./backup";
import { DIALECT } from "./dialect";
import { loadSettingsRuntime } from "../settings/boot";

export const DB_USAGE = `Usage: turntable db backup [--data-dir ./data] [--keep <n>] [--config <turntable.toml>]

Writes a consistent copy of the SQLite database to <data-dir>/backups/turntable-<time>-<version>.db
and prints its path, size and sha256. Keeps the newest --keep backups (default
TURNTABLE_BACKUP_KEEP, else 10) and refuses when free space is below twice the database size.
Not for Postgres: use pg_dump. To restore, stop the server, replace turntable.db (and delete its
-wal and -shm files), then start it.`;

export async function dbCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "backup") {
    console.error(DB_USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        "data-dir": { type: "string", default: process.env.TURNTABLE_DATA_DIR ?? "./data" },
        keep: { type: "string" },
        config: { type: "string" },
        // Read before anything else loads (db/dialect.ts); declared so strict parsing accepts it.
        "database-url": { type: "string" },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(
      `turntable db: ${e instanceof Error ? e.message : "bad arguments"}\n\n${DB_USAGE}`,
    );
    return 2;
  }
  if (DIALECT === "pg") {
    console.error(`turntable db backup: ${PG_BACKUP_MESSAGE}`);
    return 1;
  }
  const dataDir = resolve(values["data-dir"]);
  const dbPath = join(dataDir, "turntable.db");
  let result: BackupResult;
  try {
    const keep =
      values.keep === undefined
        ? backupKeepFromEnv(process.env, loadSettingsRuntime({ config: values.config }))
        : Number(values.keep);
    result = await backupSqlite({ dbPath, dataDir, version: VERSION, keep });
  } catch (e) {
    console.error(
      `turntable db backup: ${e instanceof BackupError || e instanceof Error ? e.message : "failed"}`,
    );
    return 1;
  }
  const db = openDatabase(dbPath);
  try {
    await appendAudit(
      db,
      { orgId: await systemOrgId(db) },
      {
        principalKind: "cli",
        principalId: "local",
        op: "db_backup",
        effect: "write",
        outcome: "ok",
        input: { name: result.name, size_bytes: result.sizeBytes, sha256: result.sha256 },
      },
    );
  } finally {
    db.close();
  }
  console.log(`path    ${result.path}`);
  console.log(`size    ${result.sizeBytes} bytes`);
  console.log(`sha256  ${result.sha256}`);
  if (result.pruned.length > 0) console.log(`pruned  ${result.pruned.join(", ")}`);
  return 0;
}
