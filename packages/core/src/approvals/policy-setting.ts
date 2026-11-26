// The shape of the `approval_policy` setting (#345): one map per org, keyed by environment name.
// Pure (no database), so the settings registry, the resolver's callers and the tests share it.
import { z } from "zod";

/** Most distinct approvers an environment may require. The CLI has always capped it here. */
export const MAX_REQUIRED_APPROVALS = 10;

/** Environments that always need approval and default to two people. */
export const PROTECTED_ENVIRONMENTS: readonly string[] = ["production", "release"];

export const KEY_POLICY_MODES = ["any", "hardware"] as const;

export const envPolicyEntry = z.strictObject({
  required: z.int().min(1).max(MAX_REQUIRED_APPROVALS),
  allow_author_approval: z.boolean().default(false),
  key_policy: z.enum(KEY_POLICY_MODES).default("any"),
});

export const approvalPolicyMap = z.record(z.string().min(1).max(100), envPolicyEntry);

export type EnvPolicyEntry = z.infer<typeof envPolicyEntry>;
export type ApprovalPolicyMap = z.infer<typeof approvalPolicyMap>;

/** What an environment with no entry has: protected ones need two people, the rest need none. */
export function defaultEnvEntry(environment: string): { entry: EnvPolicyEntry; gated: boolean } {
  const gated = PROTECTED_ENVIRONMENTS.includes(environment);
  return {
    entry: {
      required: gated ? 2 : 1,
      allow_author_approval: false,
      key_policy: "any",
    },
    gated,
  };
}

/** One environment's effective entry in a map: its own, or the built-in default. */
export const effective = (map: ApprovalPolicyMap, environment: string) => {
  const e = map[environment];
  return e ? { entry: e, gated: true } : defaultEnvEntry(environment);
};

/**
 * The parts of a change to the map that weaken a protection, per environment: fewer approvers
 * required, the author allowed to approve, a hardware key policy relaxed to any key, or an
 * environment that waited for approval no longer doing so. Compared as effective policies, so
 * removing an entry counts when the default is weaker than what it held.
 */
export function approvalPolicyLoosening(
  before: ApprovalPolicyMap,
  after: ApprovalPolicyMap,
): string[] {
  const out: string[] = [];
  for (const environment of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = effective(before, environment);
    const a = effective(after, environment);
    if (a.gated && a.entry.required < b.entry.required)
      out.push(
        `${environment}: approvers required ${b.entry.required} -> ${a.entry.required}${
          a.entry.required < 2 ? " (one person can approve alone)" : ""
        }`,
      );
    if (a.entry.allow_author_approval && !b.entry.allow_author_approval)
      out.push(`${environment}: the author of a run may approve it`);
    if (b.entry.key_policy === "hardware" && a.entry.key_policy === "any")
      out.push(`${environment}: any key may approve, not only hardware keys`);
    if (b.gated && !a.gated) out.push(`${environment}: no longer waits for approval`);
  }
  return out;
}
