// Event feed, attempt steps and log cuts. Like index.ts, part of the only code that names
// tenant tables. Event writers run inside the transaction of the change they describe.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { EventType, StepResult, StepStage } from "../schema";
import { ulid } from "../ulid";
import { requireProject, type Scope, scoped } from "./scope";

export type EventRow = typeof s.events.$inferSelect;
export type AttemptStep = typeof s.attemptSteps.$inferSelect;
export type LogCut = typeof s.logCuts.$inferSelect;

const EVENT_COLS = { orgId: s.events.orgId, projectId: s.events.projectId };
const STEP_COLS = { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId };
const CUT_COLS = { orgId: s.logCuts.orgId, projectId: s.logCuts.projectId };

// ---- events ----

/** Called by the repos after an event is committed; the feed's long-poll wakes on it. */
type Listener = (orgId: string) => void;
const listeners = new Set<Listener>();

/**
 * Subscribes to "an event was appended for this org". Fired after the appending transaction
 * commits, never inside it, so a woken reader sees the row. Returns an unsubscribe function.
 */
export function onEventsAppended(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after a log chunk is committed; live log tails wake on it instead of polling. */
type LogListener = (orgId: string, attemptId: string) => void;
const logListeners = new Set<LogListener>();

/**
 * Subscribes to "a log chunk was appended to this attempt". Fired after the appending transaction
 * commits, never inside it, so a woken reader sees the bytes. In-process only: another process
 * appending to the same database is not seen, which is why readers keep a slow safety poll.
 */
export function onLogAppended(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

/** For the log writer: schedules the wake-up for after the surrounding transaction commits. */
export function notifyLogAppended(
  h: { afterCommit(fn: () => void): void },
  orgId: string,
  attemptId: string,
): void {
  h.afterCommit(() => {
    for (const l of logListeners) l(orgId, attemptId);
  });
}

/**
 * Appends an event and returns its cursor. Call it with the transaction handle of the change it
 * describes, so a rolled-back change leaves no event. Tenant columns come from `scope`.
 */
export function appendEvent(
  db: Db,
  scope: Scope,
  input: {
    type: EventType;
    runId?: string | undefined;
    jobId?: string | undefined;
    attemptId?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  },
): Promise<number> {
  return db.run(async (h) => {
    const rows = await h.orm
      .insert(s.events)
      .values({
        publicId: ulid(),
        orgId: scope.orgId,
        projectId: scope.projectId ?? null,
        type: input.type,
        runId: input.runId ?? null,
        jobId: input.jobId ?? null,
        attemptId: input.attemptId ?? null,
        payload: JSON.stringify(input.payload ?? {}),
      })
      .returning({ id: s.events.id });
    // Wake the feed's long-poll only once the surrounding transaction has committed.
    const orgId = scope.orgId;
    h.afterCommit(() => {
      for (const l of listeners) l(orgId);
    });
    return rows[0]!.id;
  });
}

export type EventFilter = {
  /** Cursor: only events with an id greater than this. 0 starts from the beginning. */
  after: number;
  limit: number;
  types?: readonly EventType[] | undefined;
};

/** Events in cursor order, scoped to the tenant. */
export function listEvents(db: Db, scope: Scope, f: EventFilter): Promise<EventRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.events)
      .where(
        scoped(
          scope,
          EVENT_COLS,
          gt(s.events.id, f.after),
          f.types && f.types.length > 0 ? inArray(s.events.type, [...f.types]) : undefined,
        ),
      )
      .orderBy(asc(s.events.id))
      .limit(f.limit),
  );
}

/** The newest cursor in scope (0 when empty), so a client can start tailing from now. */
export function latestEventId(db: Db, scope: Scope): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ id: sql<number | null>`max(${s.events.id})` })
      .from(s.events)
      .where(scoped(scope, EVENT_COLS));
    return Number(row?.id ?? 0);
  });
}

// ---- steps ----

export type StepInput = {
  attemptId: string;
  stepKey: string;
  stage: StepStage;
  index: number;
  name: string;
  result?: StepResult | null | undefined;
  startedAt?: number | null | undefined;
  finishedAt?: number | null | undefined;
  logOffset?: number | undefined;
};

/**
 * Inserts or updates a step (unique per attempt, step_key and stage). Returns undefined when
 * the attempt is not in scope. Emits `attempt.step` in the same transaction.
 */
export function upsertStep(
  db: Db,
  scope: Scope,
  input: StepInput,
): Promise<AttemptStep | undefined> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const [attempt] = await tx.orm
      .select({ id: s.jobAttempts.id, jobId: s.jobAttempts.jobId })
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!attempt) return undefined;
    const values = {
      orgId: scope.orgId,
      projectId,
      attemptId: input.attemptId,
      stepKey: input.stepKey,
      stage: input.stage,
      stepIndex: input.index,
      name: input.name,
      result: input.result ?? null,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      logOffset: input.logOffset ?? 0,
    };
    await tx.orm
      .insert(s.attemptSteps)
      .values(values)
      .onConflictDoUpdate({
        target: [s.attemptSteps.attemptId, s.attemptSteps.stepKey, s.attemptSteps.stage],
        set: {
          stepIndex: values.stepIndex,
          name: values.name,
          result: values.result,
          startedAt: values.startedAt,
          finishedAt: values.finishedAt,
          logOffset: values.logOffset,
        },
      });
    await appendEvent(tx, scope, {
      type: "attempt.step",
      jobId: attempt.jobId,
      attemptId: input.attemptId,
      payload: {
        step_key: input.stepKey,
        stage: input.stage,
        index: input.index,
        name: input.name,
        result: input.result ?? null,
      },
    });
    const [row] = await tx.orm
      .select()
      .from(s.attemptSteps)
      .where(
        scoped(
          scope,
          STEP_COLS,
          and(
            eq(s.attemptSteps.attemptId, input.attemptId),
            eq(s.attemptSteps.stepKey, input.stepKey),
            eq(s.attemptSteps.stage, input.stage),
          ),
        ),
      )
      .limit(1);
    return row;
  });
}

/** Steps of an attempt in run order. Empty when the attempt is not in scope. */
export function listSteps(db: Db, scope: Scope, attemptId: string): Promise<AttemptStep[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.attemptSteps)
      .where(scoped(scope, STEP_COLS, eq(s.attemptSteps.attemptId, attemptId)))
      .orderBy(asc(s.attemptSteps.stepIndex), asc(s.attemptSteps.stage)),
  );
}

// ---- cuts ----

/**
 * Records that `omittedBytes` were dropped at `atOffset` of an attempt's log. Idempotent per
 * offset. Returns false when the attempt is not in scope. Emits `attempt.cut` atomically.
 */
export function addCut(
  db: Db,
  scope: Scope,
  input: { attemptId: string; atOffset: number; omittedBytes: number; reason: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const [attempt] = await tx.orm
      .select({ jobId: s.jobAttempts.jobId })
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!attempt) return false;
    await tx.orm
      .insert(s.logCuts)
      .values({
        orgId: scope.orgId,
        projectId,
        attemptId: input.attemptId,
        atOffset: input.atOffset,
        omittedBytes: input.omittedBytes,
        reason: input.reason,
      })
      .onConflictDoNothing();
    await appendEvent(tx, scope, {
      type: "attempt.cut",
      jobId: attempt.jobId,
      attemptId: input.attemptId,
      payload: {
        at_offset: input.atOffset,
        omitted_bytes: input.omittedBytes,
        reason: input.reason,
      },
    });
    return true;
  });
}

export function listCuts(db: Db, scope: Scope, attemptId: string): Promise<LogCut[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.logCuts)
      .where(scoped(scope, CUT_COLS, eq(s.logCuts.attemptId, attemptId)))
      .orderBy(asc(s.logCuts.atOffset)),
  );
}
