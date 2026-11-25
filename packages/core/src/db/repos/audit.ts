// The audit chain, its checkpoints and export cursors. Like index.ts, part of the only code
// allowed to name tenant tables.
import { and, asc, desc, eq, gt, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "..";
import { entryHash, GENESIS_HASH, type ChainFields } from "../../audit/chain";
import * as s from "../schema";
import { ulid } from "../ulid";
import type { Scope } from "./scope";

export type AuditRow = typeof s.auditLog.$inferSelect;
export type AuditCheckpoint = typeof s.auditCheckpoints.$inferSelect;

const AUDIT_INPUT_MAX = 2048;

export interface AuditEntryInput {
  principalKind: string;
  principalId: string;
  op: string;
  effect: string;
  outcome: string;
  input: unknown;
}

/**
 * Appends to the org's chain. Reading the head and inserting happen in one transaction (a
 * savepoint when the caller already holds one), so two writers can never take the same position,
 * and each entry's hash covers the entry before it.
 */
export function appendAudit(db: Db, scope: Scope, entry: AuditEntryInput): Promise<void> {
  // Named by org: on Postgres, appends to one org's chain from this process queue instead of
  // colliding under SERIALIZABLE (see Db.transaction).
  return db.transaction(
    async (tx) => {
      let input = JSON.stringify(entry.input ?? null);
      if (input.length > AUDIT_INPUT_MAX)
        input = `${input.slice(0, AUDIT_INPUT_MAX)}...(truncated)`;
      const [head] = await tx.orm
        .select({ seq: s.auditLog.seq, hash: s.auditLog.hash })
        .from(s.auditLog)
        .where(and(eq(s.auditLog.orgId, scope.orgId), isNotNull(s.auditLog.seq)))
        .orderBy(desc(s.auditLog.seq))
        .limit(1);
      const fields: ChainFields = {
        id: ulid(),
        orgId: scope.orgId,
        projectId: scope.projectId ?? null,
        seq: (head?.seq ?? 0) + 1,
        principalKind: entry.principalKind,
        principalId: entry.principalId,
        op: entry.op,
        effect: entry.effect,
        outcome: entry.outcome,
        input,
        createdAt: Date.now(),
      };
      const prevHash = head?.hash ?? GENESIS_HASH;
      await tx.orm.insert(s.auditLog).values({
        ...fields,
        prevHash,
        hash: entryHash(prevHash, fields),
      });
    },
    { lock: `audit:${scope.orgId}` },
  );
}

export function listAudit(db: Db, scope: Scope, opts: { limit?: number } = {}) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.auditLog)
      .where(eq(s.auditLog.orgId, scope.orgId))
      .orderBy(desc(s.auditLog.id))
      .limit(opts.limit ?? 50),
  );
}

/**
 * How many entries of one op by one principal an org's chain holds since a time, successes only.
 * For rate limits that count what was DONE: a refused call is not counted.
 */
export function countAuditEntries(
  db: Db,
  scope: Scope,
  q: { op: string; principalKind: string; principalId: string; since: number },
): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.auditLog)
      .where(
        and(
          eq(s.auditLog.orgId, scope.orgId),
          eq(s.auditLog.op, q.op),
          eq(s.auditLog.principalKind, q.principalKind),
          eq(s.auditLog.principalId, q.principalId),
          eq(s.auditLog.outcome, "ok"),
          gte(s.auditLog.createdAt, q.since),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

const likeEscape = (v: string): string => v.replaceAll(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The newest entry of one op and outcome in an org's chain whose recorded input contains a
 * literal text. For reading back a fact the op recorded (a claim's refusal) without a column.
 */
export function latestAuditContaining(
  db: Db,
  scope: Scope,
  q: { op: string; outcome: string; contains: string; since: number },
): Promise<AuditRow | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.auditLog)
      .where(
        and(
          eq(s.auditLog.orgId, scope.orgId),
          eq(s.auditLog.op, q.op),
          eq(s.auditLog.outcome, q.outcome),
          gte(s.auditLog.createdAt, q.since),
          sql`${s.auditLog.input} LIKE ${`%${likeEscape(q.contains)}%`} ESCAPE '\\'`,
        ),
      )
      .orderBy(desc(s.auditLog.createdAt), desc(s.auditLog.id))
      .limit(1);
    return row;
  });
}

/** The newest chained entry of an org, or undefined when it has none. */
export function auditHead(db: Db, orgId: string): Promise<AuditRow | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.orgId, orgId), isNotNull(s.auditLog.seq)))
      .orderBy(desc(s.auditLog.seq))
      .limit(1);
    return row;
  });
}

/** Chained entries after `afterSeq`, oldest first. */
export function chainedAudit(
  db: Db,
  orgId: string,
  afterSeq: number,
  limit: number,
): Promise<AuditRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.orgId, orgId), gt(s.auditLog.seq, afterSeq)))
      .orderBy(asc(s.auditLog.seq))
      .limit(limit),
  );
}

/** Orgs that have a chain. System-level: used by the checkpointer, the exporter and `audit verify`. */
export function orgsWithAudit(db: Db): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .selectDistinct({ orgId: s.auditLog.orgId })
      .from(s.auditLog)
      .where(isNotNull(s.auditLog.seq));
    return rows.map((r) => r.orgId);
  });
}

export function putCheckpoint(db: Db, cp: AuditCheckpoint): Promise<void> {
  return db.run(async (h) => {
    await h.orm.insert(s.auditCheckpoints).values(cp).onConflictDoNothing();
  });
}

export function listCheckpoints(db: Db, orgId: string, afterSeq = 0): Promise<AuditCheckpoint[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.auditCheckpoints)
      .where(and(eq(s.auditCheckpoints.orgId, orgId), gt(s.auditCheckpoints.seq, afterSeq)))
      .orderBy(asc(s.auditCheckpoints.seq)),
  );
}

export function latestCheckpoint(db: Db, orgId: string): Promise<AuditCheckpoint | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.auditCheckpoints)
      .where(eq(s.auditCheckpoints.orgId, orgId))
      .orderBy(desc(s.auditCheckpoints.seq))
      .limit(1);
    return row;
  });
}

export function getExportCursor(db: Db, orgId: string, sink: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ lastSeq: s.auditExportCursors.lastSeq })
      .from(s.auditExportCursors)
      .where(and(eq(s.auditExportCursors.orgId, orgId), eq(s.auditExportCursors.sink, sink)))
      .limit(1);
    return row?.lastSeq ?? 0;
  });
}

export function setExportCursor(
  db: Db,
  orgId: string,
  sink: string,
  lastSeq: number,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .insert(s.auditExportCursors)
      .values({ orgId, sink, lastSeq, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: [s.auditExportCursors.orgId, s.auditExportCursors.sink],
        set: { lastSeq, updatedAt: Date.now() },
      });
  });
}
