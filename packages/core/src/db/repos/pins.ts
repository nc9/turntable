// Action pins and the action policy. Like index.ts, part of the only code allowed to name
// tenant tables.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { requireProject, type Scope, scoped } from "./scope";

export type ActionPin = typeof s.actionPins.$inferSelect;

export interface ActionPolicy {
  /** Refuse any `uses:` that is not already a full commit sha. */
  requireShaPins: boolean;
  /** Owners (`actions`, `oven-sh`, ...) allowed for `uses:`, lowercase; null means no allowlist. */
  allowedOwners: string[] | null;
}

const PIN_COLS = { orgId: s.actionPins.orgId, projectId: s.actionPins.projectId };

export function getActionPolicy(db: Db, scope: Scope): Promise<ActionPolicy> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [proj] = await h.orm
      .select({ requireShaPins: s.projects.requireShaPins })
      .from(s.projects)
      .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, projectId)))
      .limit(1);
    const [org] = await h.orm
      .select({ list: s.orgs.actionOwnerAllowlist })
      .from(s.orgs)
      .where(eq(s.orgs.id, scope.orgId))
      .limit(1);
    let allowedOwners: string[] | null = null;
    if (org?.list) {
      const parsed: unknown = JSON.parse(org.list);
      if (Array.isArray(parsed)) allowedOwners = parsed.map((o) => String(o).toLowerCase());
    }
    return { requireShaPins: (proj?.requireShaPins ?? 0) === 1, allowedOwners };
  });
}

/** Sets the project's require_sha_pins and/or the org's allowlist (null clears it). */
export function setActionPolicy(
  db: Db,
  scope: Scope,
  patch: { requireShaPins?: boolean; allowedOwners?: readonly string[] | null },
): Promise<void> {
  return db.transaction(async (tx) => {
    if (patch.requireShaPins !== undefined) {
      const { projectId } = requireProject(scope);
      await tx.orm
        .update(s.projects)
        .set({ requireShaPins: patch.requireShaPins ? 1 : 0 })
        .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, projectId)));
    }
    if (patch.allowedOwners !== undefined) {
      await tx.orm
        .update(s.orgs)
        .set({
          actionOwnerAllowlist:
            patch.allowedOwners === null
              ? null
              : JSON.stringify(patch.allowedOwners.map((o) => o.toLowerCase())),
        })
        .where(eq(s.orgs.id, scope.orgId));
    }
  });
}

export type PinObservation =
  | { status: "new" | "same"; pinned: string }
  /** The tag now points at `observed`, not at `pinned`. */
  | { status: "moved"; pinned: string; observed: string };

/**
 * Records a resolution. A first sight pins it; the same sha refreshes last_seen (and clears a
 * pending move if the tag moved back); a different sha is a moved tag: the pin is NOT changed,
 * the new sha is held as pending until `acceptActionMove`.
 */
export function observePin(
  db: Db,
  scope: Scope,
  input: { repo: string; ref: string; sha: string },
): Promise<PinObservation> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const repo = input.repo.toLowerCase();
    const now = Date.now();
    const where = scoped(
      scope,
      PIN_COLS,
      eq(s.actionPins.repo, repo),
      eq(s.actionPins.ref, input.ref),
    );
    const [pin] = await tx.orm.select().from(s.actionPins).where(where).limit(1);
    if (!pin) {
      await tx.orm.insert(s.actionPins).values({
        orgId: scope.orgId,
        projectId,
        repo,
        ref: input.ref,
        sha: input.sha,
        firstSeen: now,
        lastSeen: now,
      });
      return { status: "new", pinned: input.sha };
    }
    if (pin.sha === input.sha) {
      await tx.orm.update(s.actionPins).set({ lastSeen: now, pendingSha: null }).where(where);
      return { status: "same", pinned: pin.sha };
    }
    await tx.orm.update(s.actionPins).set({ lastSeen: now, pendingSha: input.sha }).where(where);
    return { status: "moved", pinned: pin.sha, observed: input.sha };
  });
}

export type AcceptResult =
  | { ok: true; previousSha: string }
  | { ok: false; reason: "no_pin" | "no_pending_move" | "sha_mismatch" };

/**
 * An operator accepts a moved tag. `sha` must be the commit the tag was observed at (the pending
 * one), so an accept never blesses something the operator did not look at.
 */
export function acceptActionMove(
  db: Db,
  scope: Scope,
  input: { repo: string; ref: string; sha: string },
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const where = scoped(
      scope,
      PIN_COLS,
      eq(s.actionPins.repo, input.repo.toLowerCase()),
      eq(s.actionPins.ref, input.ref),
    );
    const [pin] = await tx.orm.select().from(s.actionPins).where(where).limit(1);
    if (!pin) return { ok: false, reason: "no_pin" };
    if (pin.pendingSha === null) return { ok: false, reason: "no_pending_move" };
    if (pin.pendingSha !== input.sha) return { ok: false, reason: "sha_mismatch" };
    await tx.orm
      .update(s.actionPins)
      .set({ sha: input.sha, pendingSha: null, acceptedAt: Date.now() })
      .where(where);
    return { ok: true, previousSha: pin.sha };
  });
}

export function listActionPins(db: Db, scope: Scope): Promise<ActionPin[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.actionPins)
      .where(scoped(scope, PIN_COLS))
      .orderBy(asc(s.actionPins.repo), asc(s.actionPins.ref)),
  );
}

/** Pins with an unaccepted move, for the operator. */
export function listPendingMoves(db: Db, scope: Scope): Promise<ActionPin[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select()
      .from(s.actionPins)
      .where(and(scoped(scope, PIN_COLS)));
    return rows.filter((r) => r.pendingSha !== null);
  });
}
