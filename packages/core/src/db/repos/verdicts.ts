// Persisted action verdicts (see `action_verdicts`). Part of the only code allowed to name
// tenant tables.
import { and, eq, inArray, lt, not, or } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { requireProject, type Scope, scoped } from "./scope";

/** `_auth` verdicts were learned with a credential and are kept apart from anonymous ones. */
export type VerdictKind = "resolve" | "resolve_auth" | "reach" | "reach_auth" | "public";

const COLS = { orgId: s.actionVerdicts.orgId, projectId: s.actionVerdicts.projectId };

/** A verdict younger than `maxAgeMs`, or undefined. For `resolve`, `sha` is the result. */
export function getVerdict(
  db: Db,
  scope: Scope,
  key: { kind: VerdictKind; repo: string; ref?: string; sha?: string },
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<{ verdict: boolean; sha: string; checkedAt: number } | undefined> {
  return db.run(async (h) => {
    requireProject(scope);
    const rows = await h.orm
      .select()
      .from(s.actionVerdicts)
      .where(
        scoped(
          scope,
          COLS,
          eq(s.actionVerdicts.kind, key.kind),
          eq(s.actionVerdicts.repo, key.repo.toLowerCase()),
          eq(s.actionVerdicts.ref, key.ref ?? ""),
          ...(key.sha === undefined ? [] : [eq(s.actionVerdicts.sha, key.sha)]),
        ),
      );
    const fresh = rows
      .filter((r) => now - r.checkedAt < maxAgeMs)
      .toSorted((a, b) => b.checkedAt - a.checkedAt)[0];
    return fresh
      ? { verdict: fresh.verdict === 1, sha: fresh.sha, checkedAt: fresh.checkedAt }
      : undefined;
  });
}

/** Records (or refreshes) a verdict, and drops this project's verdicts older than `keepMs`. */
export function putVerdict(
  db: Db,
  scope: Scope,
  v: { kind: VerdictKind; repo: string; ref?: string; sha: string; verdict: boolean },
  opts: { now?: number; keepMs?: number } = {},
): Promise<void> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const now = opts.now ?? Date.now();
    await tx.orm
      .insert(s.actionVerdicts)
      .values({
        orgId: scope.orgId,
        projectId,
        kind: v.kind,
        repo: v.repo.toLowerCase(),
        ref: v.ref ?? "",
        sha: v.sha,
        verdict: v.verdict ? 1 : 0,
        checkedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          s.actionVerdicts.projectId,
          s.actionVerdicts.kind,
          s.actionVerdicts.repo,
          s.actionVerdicts.ref,
          s.actionVerdicts.sha,
        ],
        set: { verdict: v.verdict ? 1 : 0, checkedAt: now },
      });
    await tx.orm.delete(s.actionVerdicts).where(
      and(
        scoped(scope, COLS),
        lt(s.actionVerdicts.checkedAt, now - (opts.keepMs ?? 7 * 86_400_000)),
        // A verified commit is immutable (#621): its yes verdict is never aged out.
        or(
          not(inArray(s.actionVerdicts.kind, ["reach", "reach_auth"])),
          not(eq(s.actionVerdicts.verdict, 1)),
        ),
      ),
    );
  });
}
