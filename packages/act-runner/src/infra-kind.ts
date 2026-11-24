/**
 * Why an attempt ended `infra_error`, as a name from a small closed set. The kind is carried next
 * to the reason (whose text is unchanged) so the scheduler can decide whether one retry is worth
 * it. This table is the only place that says which kinds are transient, and whether each one
 * happens before any job step runs (`beforeSteps`). A kind that can happen mid-run could follow
 * steps with side effects (a deploy, a publish), so it is retried only for pull request jobs.
 */
export const INFRA_KINDS = {
  /** The sandbox's Docker daemon never came up (`docker info` failed). */
  docker_daemon_unavailable: {
    transient: true,
    beforeSteps: true,
    label: "the sandbox's Docker daemon was unavailable",
  },
  /** The provider could not create the sandbox. */
  sandbox_create_failed: {
    transient: true,
    beforeSteps: true,
    label: "the sandbox could not be created",
  },
  /** The sandbox or the act process in it vanished before a result, possibly mid-run. */
  sandbox_lost: { transient: true, beforeSteps: false, label: "the sandbox was lost" },
  /** Reserved for a rate-limited image pull (#513): nothing produces it yet. It is the preflight. */
  image_pull_rate_limited: {
    transient: true,
    beforeSteps: true,
    label: "an image pull was rate limited",
  },
  /** Everything else: a deterministic or unknown cause. Never retried. */
  other: {
    transient: false,
    beforeSteps: false,
    label: "an infrastructure error",
  },
} as const satisfies Record<string, { transient: boolean; beforeSteps: boolean; label: string }>;

export type InfraKind = keyof typeof INFRA_KINDS;

export function isInfraKind(v: unknown): v is InfraKind {
  return typeof v === "string" && Object.hasOwn(INFRA_KINDS, v);
}

/**
 * True for a kind worth one retry on a fresh sandbox. A kind that can happen mid-run is retried
 * only for a pull request job (`trusted_pr`, `untrusted_pr`); `protected` and `release` jobs may
 * have deployed or published before the sandbox died, so they end `infra_error`. An unknown class
 * counts as not a pull request.
 */
export function isRetryableInfra(
  kind: InfraKind | null | undefined,
  trustClass: string | null | undefined,
): boolean {
  if (kind == null || !INFRA_KINDS[kind].transient) return false;
  return (
    INFRA_KINDS[kind].beforeSteps || trustClass === "trusted_pr" || trustClass === "untrusted_pr"
  );
}
