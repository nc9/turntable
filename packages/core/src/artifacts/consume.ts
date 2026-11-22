// Who may consume which artifact (#39). The core invariant: a release build consumes nothing a
// lower trust class could write. Classes are ordered by how much code review stands behind them:
// untrusted_pr < trusted_pr < protected < release. An artifact carries the class of the run that
// produced it, set by the control plane when it was recorded. A consumer may always take an
// artifact of its own class or a higher one. A lower-class artifact reaches a higher-class
// consumer only on an explicit request, as quarantine: never executable, never an input to a
// release build. A release consumer takes only release-class artifacts, no exceptions.
import type { TrustClass } from "../trust";

export const CLASS_ORDER: readonly TrustClass[] = [
  "untrusted_pr",
  "trusted_pr",
  "protected",
  "release",
];

/** Rank of a class; an unknown or missing class is the lowest (fail closed). */
export function classRank(klass: string | undefined | null): number {
  const i = CLASS_ORDER.indexOf(klass as TrustClass);
  return i < 0 ? 0 : i;
}

export type ConsumeDecision =
  /** Same class or higher: usable as is. */
  | { decision: "allow" }
  /** Lower class, explicitly requested: delivered into quarantine, non-executable. */
  | { decision: "quarantine" }
  | { decision: "deny"; reason: string };

export function decideConsumption(o: {
  consumer: string | undefined | null;
  producer: string | undefined | null;
  /** The consumer asked, by name, for a lower-class artifact. */
  explicit: boolean;
}): ConsumeDecision {
  const consumer = classRank(o.consumer);
  const producer = classRank(o.producer);
  if (producer >= consumer) {
    // Release takes release only: "protected" is above the consumer's rank only for lower ones.
    return { decision: "allow" };
  }
  if (o.consumer === "release")
    return {
      decision: "deny",
      reason: "a release build consumes nothing below the release class",
    };
  if (!o.explicit)
    return {
      decision: "deny",
      reason: "this artifact came from a lower trust class: request it explicitly to quarantine it",
    };
  return { decision: "quarantine" };
}

/** The lower of two classes; either one missing or unknown gives the lowest. */
export function lowerClass(a: string | undefined | null, b: string | undefined | null): TrustClass {
  const ra = classRank(a);
  const rb = classRank(b);
  const known = (x: string | undefined | null) => CLASS_ORDER.includes(x as TrustClass);
  if (!known(a) || !known(b)) return "untrusted_pr";
  return CLASS_ORDER[Math.min(ra, rb)]!;
}
