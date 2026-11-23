// `db_backup` (#280): the instance takes its own SQLite backup, because the image has no shell to
// copy the file with. Instance administrator only (a `tti_` token over REST), never an MCP tool,
// audited in the system org's chain by the dispatcher. The caller names no path: the file is
// always new, under `<data-dir>/backups/`.
import { z } from "zod";
import { BackupError, backupSqlite, PG_BACKUP_MESSAGE } from "../../db/backup";
import { VERSION } from "../../version";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const dbBackupOp = defineOp({
  name: "db_backup",
  summary: "Back up the SQLite database into the data dir (instance administrator only).",
  description:
    "Writes a consistent copy of the SQLite database (VACUUM INTO) to a new file under " +
    "`<data-dir>/backups/`, named with the time and the binary version, and returns its path, " +
    "size and sha256. Use it before an upgrade that applies migrations. It keeps the newest " +
    "`keep` backups (default from TURNTABLE_BACKUP_KEEP, else 10) and refuses when free space " +
    "is below twice the database size. On Postgres it refuses: use pg_dump. Restoring is " +
    "stop, replace the file, start. The copy runs on a worker thread, so the server keeps serving while it runs. Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    keep: z
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe("How many backups to keep, newest first. Older ones are deleted."),
  }),
  output: z.object({
    path: z.string(),
    name: z.string(),
    size_bytes: z.int(),
    sha256: z.string(),
    version: z.string(),
    created_at: z.string(),
    pruned: z.array(z.string()),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/db-backup" },
  mcp: false,
  // VACUUM INTO of a large database takes seconds (on a worker thread). It reads through its own connection, so it
  // must not sit inside the dispatcher's write transaction, which would block every other writer.
  outsideTransaction: true,
  auditDetail: (o) => ({ name: o.name, size_bytes: o.size_bytes, sha256: o.sha256 }),
  async handler(ctx, i) {
    const cfg = ctx.backup;
    if (cfg?.dialect === "pg") throw new OpError("invalid_input", PG_BACKUP_MESSAGE);
    if (!cfg) throw new OpError("unavailable", "this server was not set up to take backups");
    try {
      const r = await backupSqlite({
        dbPath: cfg.dbPath,
        dataDir: cfg.dataDir,
        version: VERSION,
        keep: i.keep ?? cfg.keep,
        now: ctx.now,
        afterCopy: cfg.afterCopy,
      });
      return {
        path: r.path,
        name: r.name,
        size_bytes: r.sizeBytes,
        sha256: r.sha256,
        version: r.version,
        created_at: new Date(r.createdAt).toISOString(),
        pruned: r.pruned,
      };
    } catch (err) {
      if (err instanceof BackupError) {
        throw new OpError(
          err.code === "failed"
            ? "internal"
            : err.code === "no_space"
              ? "unavailable"
              : "invalid_input",
          err.message,
        );
      }
      throw err;
    }
  },
});
