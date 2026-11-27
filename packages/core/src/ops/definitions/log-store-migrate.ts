// `log_store_migrate` (#717): copies recent job logs from the main database into the configured
// log store (ClickHouse), verifies the counts, and can be run again.
import { z } from "zod";
import { externalLogStore } from "../../logstore/registry";
import { migrateDaysFromEnv } from "../../logstore/config";
import { migrateLogs } from "../../logstore/migrate";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const logStoreMigrateOp = defineOp({
  name: "log_store_migrate",
  summary: "Copy recent job logs into the external log store (instance administrator only).",
  description:
    "Copies the logs of attempts created in the last `days` days (default `TURNTABLE_LOG_MIGRATE_DAYS`, 14) " +
    "from the main database into the configured log store (`TURNTABLE_LOG_STORE=clickhouse`), then compares " +
    "chunk count and size per attempt. It is idempotent: an attempt already copied is skipped, and a second " +
    "run changes nothing. Rows in the database are not deleted. It refuses when no external store is configured. " +
    "Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    days: z
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("How far back to copy, in days. Default: the TURNTABLE_LOG_MIGRATE_DAYS setting."),
  }),
  output: z.object({
    attempts: z.int(),
    copied: z.int(),
    skipped: z.int(),
    chunks: z.int(),
    bytes: z.int(),
    verified: z.int(),
    mismatches: z.array(z.string()),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/log-store-migrate" },
  mcp: false,
  // Copying takes minutes and talks to the store: it must not sit inside the write transaction.
  outsideTransaction: true,
  auditDetail: (o) => ({ attempts: o.attempts, copied: o.copied, mismatches: o.mismatches.length }),
  async handler(ctx, i) {
    const store = externalLogStore();
    if (!store) {
      throw new OpError(
        "unavailable",
        "no external log store is configured (set TURNTABLE_LOG_STORE=clickhouse)",
      );
    }
    return migrateLogs(ctx.db, store, { days: i.days ?? migrateDaysFromEnv(), now: ctx.now() });
  },
});
