// The fixture backend's stand-in for the server's artifact consumption rule
// (`packages/core/src/artifacts/consume.ts`). Only the fixture uses it, to give the UI
// server-shaped answers; the real UI asks the server and never decides.
const ORDER = ["untrusted_pr", "trusted_pr", "protected", "release"] as const;
const rank = (c: string | null | undefined): number => {
  const i = ORDER.indexOf(c as (typeof ORDER)[number]);
  return i < 0 ? 0 : i;
};

export function fixtureDecision(o: {
  consumer: string | null | undefined;
  producer: string | null | undefined;
  explicit: boolean;
}): { decision: "allow" | "quarantine" | "deny"; reason: string | null } {
  if (rank(o.producer) >= rank(o.consumer)) return { decision: "allow", reason: null };
  if (o.consumer === "release")
    return { decision: "deny", reason: "a release build consumes nothing below the release class" };
  if (!o.explicit)
    return {
      decision: "deny",
      reason: "this artifact came from a lower trust class: request it explicitly to quarantine it",
    };
  return { decision: "quarantine", reason: null };
}
