// How an artifact is shown (#39): its class against its run's, and whether a build of a given
// class may take it. The rule mirrors the server's (`artifacts/consume.ts`): same or higher class
// is allowed; lower needs an explicit request and arrives as quarantine; a release build takes
// nothing below release. The server decides; this is for labels and the fixture backend.
import type { ConsumeDecision } from "@/api/types";

export const CLASS_ORDER = ["untrusted_pr", "trusted_pr", "protected", "release"] as const;

export function classRank(c: string | null | undefined): number {
  const i = CLASS_ORDER.indexOf(c as (typeof CLASS_ORDER)[number]);
  return i < 0 ? 0 : i;
}

export function decideConsumption(o: {
  consumer: string | null | undefined;
  producer: string | null | undefined;
  explicit: boolean;
}): { decision: ConsumeDecision; reason: string | null } {
  if (classRank(o.producer) >= classRank(o.consumer)) return { decision: "allow", reason: null };
  if (o.consumer === "release")
    return { decision: "deny", reason: "a release build consumes nothing below the release class" };
  if (!o.explicit)
    return {
      decision: "deny",
      reason: "this artifact came from a lower trust class: request it explicitly to quarantine it",
    };
  return { decision: "quarantine", reason: null };
}

/** Lower than the run that holds it: it was written by a less trusted attempt. */
export function belowRun(artifactClass: string, runClass: string | null | undefined): boolean {
  return classRank(artifactClass) < classRank(runClass);
}

/** A release build may take only release-class artifacts. */
export const releaseUsable = (artifactClass: string): boolean => artifactClass === "release";

export function shortDigest(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-6)}`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `18.4 MB`; decimal units. */
export function formatSize(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[i]}`;
}
