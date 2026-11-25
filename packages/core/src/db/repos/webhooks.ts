// Outbound webhooks: endpoints, the org signing secret's versions, and the delivery outbox. Part
// of the only code that names tenant tables. Fan-out and delivery are system work across orgs, so
// a few functions here take no scope; each row they touch carries its own org id.
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, max, or, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { EventType } from "../schema";
import { ulid } from "../ulid";
import { appendEvent, latestSettledEventId } from "./events";
import { type Scope, scoped } from "./scope";

export type OutboundEndpoint = typeof s.outboundEndpoints.$inferSelect;
export type OutboundSecretRow = typeof s.outboundSecrets.$inferSelect;
export type OutboundDelivery = typeof s.outboundDeliveries.$inferSelect;
import type { EventRow } from "./events";

const EP = { orgId: s.outboundEndpoints.orgId, projectId: s.outboundEndpoints.projectId };
const DEL = { orgId: s.outboundDeliveries.orgId };

// ---- endpoints ----

export async function createOutboundEndpoint(
  db: Db,
  scope: Scope,
  input: {
    url: string;
    description: string;
    eventTypes: readonly EventType[] | null;
    format?: s.WebhookFormat | undefined;
    createdBy: string;
    /** Start at the beginning of the feed instead of its tip. */
    fromStart: boolean;
    now: number;
    /** The settle window (see fan-out): the start is the newest settled id, not the raw tip. */
    settleMs?: number;
  },
): Promise<OutboundEndpoint> {
  const cursor = input.fromStart
    ? 0
    : await latestSettledEventId(
        db,
        { orgId: scope.orgId },
        { settleMs: input.settleMs ?? 0, now: input.now },
      );
  return db.run(async (h) => {
    const rows = await h.orm
      .insert(s.outboundEndpoints)
      .values({
        id: ulid(),
        orgId: scope.orgId,
        projectId: scope.projectId ?? null,
        url: input.url,
        description: input.description,
        eventTypes:
          input.eventTypes && input.eventTypes.length > 0 ? JSON.stringify(input.eventTypes) : null,
        format: input.format ?? "json",
        cursor,
        createdBy: input.createdBy,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return rows[0]!;
  });
}

export function listOutboundEndpoints(db: Db, scope: Scope): Promise<OutboundEndpoint[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.outboundEndpoints)
      .where(scoped(scope, EP))
      .orderBy(asc(s.outboundEndpoints.createdAt), asc(s.outboundEndpoints.id)),
  );
}

export async function getOutboundEndpoint(
  db: Db,
  scope: Scope,
  id: string,
): Promise<OutboundEndpoint | undefined> {
  const rows = await db.run((h) =>
    h.orm
      .select()
      .from(s.outboundEndpoints)
      .where(scoped(scope, EP, eq(s.outboundEndpoints.id, id)))
      .limit(1),
  );
  return rows[0];
}

/** Disables or re-enables an endpoint. Re-enabling clears the failure count. */
export async function setOutboundEndpointState(
  db: Db,
  scope: Scope,
  id: string,
  state: "active" | "disabled",
  reason: string | null,
  now: number,
): Promise<OutboundEndpoint | undefined> {
  const rows = await db.run((h) =>
    h.orm
      .update(s.outboundEndpoints)
      .set({
        state,
        disabledReason: state === "disabled" ? reason : null,
        ...(state === "active" ? { consecutiveFailures: 0 } : {}),
        updatedAt: now,
      })
      .where(scoped(scope, EP, eq(s.outboundEndpoints.id, id)))
      .returning(),
  );
  return rows[0];
}

/** Every active endpoint, for the fan-out loop (system work, all orgs). */
export function listActiveOutboundEndpoints(db: Db): Promise<OutboundEndpoint[]> {
  return db.run((h) =>
    h.orm.select().from(s.outboundEndpoints).where(eq(s.outboundEndpoints.state, "active")),
  );
}

// ---- secrets ----

/** The org's secret versions that sign now (the newest, and a retired one inside its overlap). */
export function activeWebhookSecrets(
  db: Db,
  scope: Scope,
  now: number,
): Promise<OutboundSecretRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.outboundSecrets)
      .where(
        and(
          eq(s.outboundSecrets.orgId, scope.orgId),
          or(isNull(s.outboundSecrets.expiresAt), gt(s.outboundSecrets.expiresAt, now)),
        ),
      )
      .orderBy(desc(s.outboundSecrets.version)),
  );
}

/**
 * Adds a new secret version and starts the overlap of the previous current one: it keeps signing
 * until `now + overlapMs`. `seal` gets the new version number so it can bind it into the record.
 */
export function addWebhookSecret(
  db: Db,
  scope: Scope,
  seal: (version: number) => string,
  now: number,
  overlapMs: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    const [m] = await tx.orm
      .select({ v: max(s.outboundSecrets.version) })
      .from(s.outboundSecrets)
      .where(eq(s.outboundSecrets.orgId, scope.orgId));
    const version = Number(m?.v ?? 0) + 1;
    await tx.orm
      .update(s.outboundSecrets)
      .set({ expiresAt: now + overlapMs })
      .where(and(eq(s.outboundSecrets.orgId, scope.orgId), isNull(s.outboundSecrets.expiresAt)));
    await tx.orm
      .insert(s.outboundSecrets)
      .values({ orgId: scope.orgId, version, sealed: seal(version), createdAt: now });
    return version;
  });
}

// ---- fan-out ----

export type FanOut = { inserted: number; cursor: number; scanned: number };

/**
 * Moves one endpoint's cursor over the next page of its org's events and inserts a delivery row
 * for each event that matches, in ONE transaction. The cursor advances past events the endpoint
 * does not want too, so it tracks the feed. A restart re-reads from the stored cursor; the unique
 * (endpoint, event) key makes a repeat harmless. `settleMs` ignores events newer than that, for a
 * database where ids can commit out of order.
 */
export function fanOutOutboundEndpoint(
  db: Db,
  endpointId: string,
  o: { page: number; now: number; settleMs?: number },
): Promise<FanOut> {
  return db.transaction(async (tx) => {
    const [ep] = await tx.orm
      .select()
      .from(s.outboundEndpoints)
      .where(and(eq(s.outboundEndpoints.id, endpointId), eq(s.outboundEndpoints.state, "active")))
      .limit(1);
    if (!ep) return { inserted: 0, cursor: 0, scanned: 0 };
    const rows = await tx.orm
      .select()
      .from(s.events)
      .where(
        and(
          eq(s.events.orgId, ep.orgId),
          gt(s.events.id, ep.cursor),
          o.settleMs ? lte(s.events.createdAt, o.now - o.settleMs) : undefined,
        ),
      )
      .orderBy(asc(s.events.id))
      .limit(o.page);
    if (rows.length === 0) return { inserted: 0, cursor: ep.cursor, scanned: 0 };
    const types = ep.eventTypes ? (JSON.parse(ep.eventTypes) as string[]) : null;
    const wanted = rows.filter(
      (e) =>
        (ep.projectId === null || e.projectId === ep.projectId) &&
        (types === null || types.includes(e.type)),
    );
    let inserted = 0;
    for (const e of wanted) {
      const r = await tx.orm
        .insert(s.outboundDeliveries)
        .values({
          id: ulid(),
          orgId: ep.orgId,
          endpointId: ep.id,
          eventId: e.id,
          nextAttemptAt: o.now,
          createdAt: o.now,
        })
        .onConflictDoNothing()
        .returning({ id: s.outboundDeliveries.id });
      inserted += r.length;
    }
    const cursor = rows.at(-1)!.id;
    await tx.orm
      .update(s.outboundEndpoints)
      .set({ cursor })
      .where(eq(s.outboundEndpoints.id, ep.id));
    return { inserted, cursor, scanned: rows.length };
  });
}

// ---- delivery ----

export type DueDelivery = {
  delivery: OutboundDelivery;
  endpoint: OutboundEndpoint;
  event: EventRow;
};

/**
 * Takes up to `limit` due deliveries of active endpoints, oldest first, by setting a lease on each
 * with a conditional update: of two workers racing for one row, exactly one wins it.
 */
export function claimDueWebhookDeliveries(
  db: Db,
  o: { now: number; leaseMs: number; limit: number },
): Promise<DueDelivery[]> {
  return db.transaction(async (tx) => {
    const due = await tx.orm
      .select({ d: s.outboundDeliveries, e: s.outboundEndpoints })
      .from(s.outboundDeliveries)
      .innerJoin(s.outboundEndpoints, eq(s.outboundEndpoints.id, s.outboundDeliveries.endpointId))
      .where(
        and(
          eq(s.outboundDeliveries.state, "pending"),
          lte(s.outboundDeliveries.nextAttemptAt, o.now),
          or(isNull(s.outboundDeliveries.leaseUntil), lt(s.outboundDeliveries.leaseUntil, o.now)),
          eq(s.outboundEndpoints.state, "active"),
        ),
      )
      .orderBy(asc(s.outboundDeliveries.nextAttemptAt), asc(s.outboundDeliveries.eventId))
      .limit(o.limit);
    const out: DueDelivery[] = [];
    for (const { d, e } of due) {
      const won = await tx.orm
        .update(s.outboundDeliveries)
        .set({ leaseUntil: o.now + o.leaseMs })
        .where(
          and(
            eq(s.outboundDeliveries.id, d.id),
            eq(s.outboundDeliveries.state, "pending"),
            or(isNull(s.outboundDeliveries.leaseUntil), lt(s.outboundDeliveries.leaseUntil, o.now)),
          ),
        )
        .returning({ id: s.outboundDeliveries.id });
      if (won.length === 0) continue;
      const [event] = await tx.orm.select().from(s.events).where(eq(s.events.id, d.eventId));
      if (event)
        out.push({ delivery: { ...d, leaseUntil: o.now + o.leaseMs }, endpoint: e, event });
    }
    return out;
  });
}

export type AttemptResult =
  | { ok: true; status: number; response: string }
  | {
      ok: false;
      status: number | null;
      error: string;
      response: string | null;
      /** When to try again, or null to give up on this delivery. */
      retryAt: number | null;
    };

/**
 * Records one attempt: the delivery's state, and the endpoint's failure count. Reaching
 * `disableAfter` consecutive failures disables the endpoint and appends an `infra.error` event
 * in the same transaction. Returns whether this call disabled it.
 */
export function recordWebhookAttempt(
  db: Db,
  delivery: Pick<OutboundDelivery, "id" | "orgId" | "endpointId">,
  r: AttemptResult,
  o: { now: number; disableAfter: number },
): Promise<{ disabled: boolean }> {
  return db.transaction(async (tx) => {
    if (r.ok) {
      await tx.orm
        .update(s.outboundDeliveries)
        .set({
          state: "delivered",
          attempts: sql`${s.outboundDeliveries.attempts} + 1`,
          lastStatus: r.status,
          lastError: null,
          lastResponse: r.response,
          leaseUntil: null,
          deliveredAt: o.now,
        })
        .where(eq(s.outboundDeliveries.id, delivery.id));
      await tx.orm
        .update(s.outboundEndpoints)
        .set({ consecutiveFailures: 0 })
        .where(eq(s.outboundEndpoints.id, delivery.endpointId));
      return { disabled: false };
    }
    await tx.orm
      .update(s.outboundDeliveries)
      .set({
        state: r.retryAt === null ? "abandoned" : "pending",
        attempts: sql`${s.outboundDeliveries.attempts} + 1`,
        nextAttemptAt: r.retryAt ?? o.now,
        lastStatus: r.status,
        lastError: r.error.slice(0, 500),
        lastResponse: r.response,
        leaseUntil: null,
      })
      .where(eq(s.outboundDeliveries.id, delivery.id));
    const [ep] = await tx.orm
      .update(s.outboundEndpoints)
      .set({ consecutiveFailures: sql`${s.outboundEndpoints.consecutiveFailures} + 1` })
      .where(eq(s.outboundEndpoints.id, delivery.endpointId))
      .returning();
    if (!ep || ep.state !== "active" || ep.consecutiveFailures < o.disableAfter) {
      return { disabled: false };
    }
    const reason = `auto: ${ep.consecutiveFailures} consecutive failed deliveries`;
    await tx.orm
      .update(s.outboundEndpoints)
      .set({ state: "disabled", disabledReason: reason, updatedAt: o.now })
      .where(eq(s.outboundEndpoints.id, ep.id));
    await appendEvent(
      tx,
      { orgId: ep.orgId, ...(ep.projectId ? { projectId: ep.projectId } : {}) },
      {
        type: "webhook.disabled",
        payload: {
          webhook_id: ep.id,
          reason,
          consecutive_failures: ep.consecutiveFailures,
        },
      },
    );
    return { disabled: true };
  });
}

export function listWebhookDeliveries(
  db: Db,
  scope: Scope,
  f: {
    endpointId?: string | undefined;
    state?: s.OutboundDeliveryState | undefined;
    /** Newest first; `before` is a delivery's event id. */
    before?: number | undefined;
    limit: number;
  },
): Promise<OutboundDelivery[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.outboundDeliveries)
      .where(
        and(
          scoped(scope, DEL),
          f.endpointId ? eq(s.outboundDeliveries.endpointId, f.endpointId) : undefined,
          f.state ? eq(s.outboundDeliveries.state, f.state) : undefined,
          f.before ? lt(s.outboundDeliveries.eventId, f.before) : undefined,
        ),
      )
      .orderBy(desc(s.outboundDeliveries.eventId), desc(s.outboundDeliveries.id))
      .limit(f.limit),
  );
}

/** Project slugs by id, for payloads. */
export async function projectSlugsFor(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.run((h) =>
    h.orm
      .select({ id: s.projects.id, slug: s.projects.slug })
      .from(s.projects)
      .where(and(eq(s.projects.orgId, orgId), inArray(s.projects.id, [...ids]))),
  );
  return new Map(rows.map((r) => [r.id, r.slug]));
}
