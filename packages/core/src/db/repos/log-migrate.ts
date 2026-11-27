// Reads behind `log_store_migrate` (#717): which attempts have logs worth copying, and their
// stored chunks a page at a time (a log can be far larger than memory should hold at once).
import { and, asc, gt, gte, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { LogChunk, LogKey } from "../../logstore/types";

/** Attempts created at or after `since`, with at least one chunk in the database, after `afterId`. */
export function listLoggedAttempts(
  db: Db,
  since: number,
  afterId: string,
  limit: number,
): Promise<LogKey[]> {
  return db.run((h) =>
    h.orm
      .select({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        attemptId: s.jobAttempts.id,
      })
      .from(s.jobAttempts)
      .where(
        and(
          gte(s.jobAttempts.createdAt, since),
          gt(s.jobAttempts.id, afterId),
          sql`exists (select 1 from ${s.logChunks} where ${s.logChunks.attemptId} = ${s.jobAttempts.id})`,
        ),
      )
      .orderBy(asc(s.jobAttempts.id))
      .limit(limit),
  );
}

/** Up to `limit` database chunks of an attempt with offset >= `from`, in order. */
export function readLogChunkPage(
  db: Db,
  key: LogKey,
  from: number,
  limit: number,
): Promise<LogChunk[]> {
  return db.run((h) =>
    h.orm
      .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
      .from(s.logChunks)
      .where(
        and(
          sql`${s.logChunks.orgId} = ${key.orgId}`,
          sql`${s.logChunks.projectId} = ${key.projectId}`,
          sql`${s.logChunks.attemptId} = ${key.attemptId}`,
          gte(s.logChunks.offset, from),
        ),
      )
      .orderBy(asc(s.logChunks.offset))
      .limit(limit),
  );
}
