// Onboarding rows (A3): one per onboarding of an org. Tenant table: every read and write is
// scoped to the org.
import { and, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";
import type { Scope } from "./scope";

export type OnboardingRow = typeof s.onboardings.$inferSelect;

/** Starts an onboarding row. The wizard and agent-connect lanes fill in the rest as steps happen. */
export function createOnboarding(
  db: Db,
  scope: Scope,
  input: { installationId?: string | null; now?: number } = {},
): Promise<OnboardingRow> {
  return db.run(async (h) => {
    const now = input.now ?? Date.now();
    const [row] = await h.orm
      .insert(s.onboardings)
      .values({
        id: ulid(),
        orgId: scope.orgId,
        installationId: input.installationId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  });
}

export function getOnboarding(
  db: Db,
  scope: Scope,
  id: string,
): Promise<OnboardingRow | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.onboardings)
      .where(and(eq(s.onboardings.id, id), eq(s.onboardings.orgId, scope.orgId)))
      .limit(1);
    return row;
  });
}

/** Records the first run of an onboarding. Returns false when the org has no such onboarding. */
export function setOnboardingFirstRun(
  db: Db,
  scope: Scope,
  id: string,
  runId: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.onboardings)
      .set({ firstRunId: runId, updatedAt: now })
      .where(and(eq(s.onboardings.id, id), eq(s.onboardings.orgId, scope.orgId)))
      .returning({ id: s.onboardings.id });
    return rows.length > 0;
  });
}

/** Records the onboarding agent token on its onboarding. False when the org has no such row. */
export function setOnboardingAgentToken(
  db: Db,
  scope: Scope,
  id: string,
  tokenId: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.onboardings)
      .set({ agentTokenId: tokenId, updatedAt: now })
      .where(and(eq(s.onboardings.id, id), eq(s.onboardings.orgId, scope.orgId)))
      .returning({ id: s.onboardings.id });
    return rows.length > 0;
  });
}

/** Whether the run is the first run of SOME onboarding of the org (several may share one). */
export function isOnboardingFirstRun(db: Db, scope: Scope, runId: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.onboardings.id })
      .from(s.onboardings)
      .where(and(eq(s.onboardings.orgId, scope.orgId), eq(s.onboardings.firstRunId, runId)))
      .limit(1);
    return rows.length > 0;
  });
}
