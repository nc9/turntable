// Dismissed skipped checks (#386): why the check reporter stopped looking, and the events that
// make it look again.
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { Scope } from "./scope";

/** Why a skipped attempt had nothing to post. */
export type DismissReason = "checks_off" | "local_run" | "no_binding" | "no_installation";

/** Only dismissals this recent are cleared by an event, so an old backlog stays dismissed. */
export const DISMISS_CLEAR_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Clears a project's dismissals of the given reasons made within the last 24 h, so the next sweep
 * posts them. Call it when an event resolves those reasons (checks turned on, a repo claimed).
 */
export function clearRecentDismissals(
  db: Db,
  scope: Required<Scope>,
  reasons: DismissReason[],
  now = Date.now(),
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set({ checkDismissedAt: null, checkDismissedReason: null })
      .where(
        and(
          eq(s.jobAttempts.orgId, scope.orgId),
          eq(s.jobAttempts.projectId, scope.projectId),
          inArray(s.jobAttempts.checkDismissedReason, reasons),
          gte(s.jobAttempts.checkDismissedAt, now - DISMISS_CLEAR_WINDOW_MS),
        ),
      );
  });
}
