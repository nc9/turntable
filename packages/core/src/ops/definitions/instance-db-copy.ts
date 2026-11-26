// `instance_db_copy` (#716): copies the instance's SQLite database into Postgres, for the hosted
// move off SQLite. The server holds both the SQLite file and (through an env var it names) the
// Postgres URL, and hosted has no shell, so this is an op. Instance administrator only, never an
// MCP tool. The SQLite file is only read. A real run needs a drained instance.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  connectCopyTarget,
  CopyRefused,
  copySqliteToPg,
  openSnapshotSource,
} from "../../db/copy-to-pg";
import { DIALECT } from "../../db/dialect";
import { processDrain } from "../../scheduler/drain";
import { appendAudit, countRunning } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { principalId } from "../principal";

/** Only variables of this shape can name the target, so the op cannot be pointed at a secret. */
const URL_ENV = /^TURNTABLE_[A-Z0-9_]*_URL$/;
/** Never the variable the process itself is configured by: a server on SQLite must not set it. */
const RESERVED_ENV = new Set(["TURNTABLE_DATABASE_URL"]);

const tableReport = z.object({
  table: z.string(),
  source_rows: z.int(),
  target_rows: z.int(),
  copied: z.int(),
  checksum: z.string().nullable(),
});

export const instanceDbCopyOp = defineOp({
  name: "instance_db_copy",
  summary: "Copy the SQLite database into Postgres (instance administrator only).",
  description:
    "Moves an instance off SQLite. The Postgres URL is read from the environment variable named by " +
    "`target_url_env` (a `TURNTABLE_*_URL` variable other than `TURNTABLE_DATABASE_URL`, which a " +
    "server on SQLite must not set); it is never an input and never in the output. `dry_run` " +
    "applies the migrations to the target, checks it is empty (a target that holds any row in a copied table is refused), " +
    "and reports per-table row counts; it needs no drain. A real run needs the instance drained " +
    "(`instance_drain`, no running attempts). It copies every table except `exclude_tables` " +
    "(for example the log tables once logs live in the log store) in foreign-key order and in " +
    "batches, yielding between them so the server keeps answering; resets identity sequences so " +
    "the next id is above every copied one; then verifies per-table counts and a checksum over " +
    "primary keys, and walks every org's audit chain on the target (links, hashes, checkpoint " +
    "positions, head equal to the source). The source is read in one read transaction on a " +
    "separate read-only connection, so every table comes from one snapshot, and the source is " +
    "re-read at the end: a row that changed during the copy fails the run. A target that holds " +
    "any row in a copied table is refused before it is migrated. A failed copy empties the target again; a real run writes its own " +
    "audit entry before copying, so the copy carries it. The SQLite " +
    "file is never modified. Only the instance administrator can call it. Not an MCP tool.",
  input: z.object({
    target_url_env: z
      .string()
      .regex(URL_ENV)
      .max(100)
      .describe("Name of the environment variable that holds the Postgres URL."),
    dry_run: z.boolean().describe("true checks and counts only; false copies (needs a drain)."),
    exclude_tables: z
      .array(z.string().min(1).max(100))
      .max(100)
      .default([])
      .describe("Tables not copied, e.g. log_chunks, log_cuts, log_notices."),
  }),
  output: z.object({
    dry_run: z.boolean(),
    target_state: z.literal("empty"),
    migrations_applied: z.array(z.string()),
    excluded: z.array(z.string()),
    tables: z.array(tableReport),
    sequences: z.array(z.object({ table: z.string(), column: z.string(), next: z.int() })),
    audit: z.object({ orgs: z.int(), entries: z.int() }).nullable(),
    verified: z.boolean(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/db-copy" },
  mcp: false,
  // Seconds to minutes of work that yields between batches: it must not hold the dispatcher's
  // write transaction, which on SQLite is exclusive and would stop every other request.
  outsideTransaction: true,
  auditDetail: (o) => ({
    target_state: o.target_state,
    excluded: o.excluded,
    tables: o.tables.length,
    rows: o.tables.reduce((n, t) => n + t.source_rows, 0),
    verified: o.verified,
  }),
  async handler(ctx, i) {
    if (DIALECT !== "sqlite") {
      throw new OpError(
        "invalid_input",
        "this server already runs on Postgres: there is nothing to copy",
      );
    }
    if (RESERVED_ENV.has(i.target_url_env)) {
      throw new OpError(
        "invalid_input",
        "use another variable: TURNTABLE_DATABASE_URL would switch this server to Postgres at its next start",
      );
    }
    const url = process.env[i.target_url_env]?.trim();
    if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
      throw new OpError("invalid_input", "the named variable is not set to a postgres:// URL");
    }
    if (!i.dry_run) {
      const running = await countRunning(ctx.db);
      if (!processDrain.draining || running > 0) {
        throw new OpError(
          "conflict",
          "drain the instance first (`instance_drain`, then wait for no running attempts), or use dry_run",
        );
      }
    }
    if (!i.dry_run) {
      // The dispatcher appends its row after this handler returns, which is after the copy, so it
      // would never reach the target. Write the entry first: the copy then carries it.
      await appendAudit(ctx.db, ctx.scope, {
        principalKind: ctx.principal.kind,
        principalId: principalId(ctx.principal),
        op: "instance_db_copy",
        effect: "write",
        outcome: "started",
        input: { target_url_env: i.target_url_env, exclude_tables: i.exclude_tables },
      });
    }
    const src = (ctx.db.orm as unknown as { $client: Database }).$client;
    let target;
    try {
      target = await connectCopyTarget(url);
    } catch (err) {
      // the TLS refusal is a fixed sentence about configuration (no URL in it): say it
      const m = err instanceof Error ? err.message : "";
      if (m.startsWith("TURNTABLE_PG_REQUIRE_TLS")) throw new OpError("invalid_input", m);
      throw new OpError("unavailable", "could not connect to the target database");
    }
    let snapshot: ReturnType<typeof openSnapshotSource> | undefined;
    try {
      snapshot = openSnapshotSource(src);
      return await copySqliteToPg(snapshot.db, target, {
        dryRun: i.dry_run,
        exclude: i.exclude_tables,
      });
    } catch (err) {
      if (err instanceof CopyRefused) throw new OpError("conflict", err.message);
      // driver errors can carry the URL or row data: say only that the copy failed
      console.error(
        "turntable: instance_db_copy failed",
        err instanceof Error ? err.name : "error",
      );
      throw new OpError(
        "unavailable",
        "the copy failed; the target is left empty or untouched. See the server log",
      );
    } finally {
      snapshot?.close();
      await target.close().catch(() => {});
    }
  },
});
