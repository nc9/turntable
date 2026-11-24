/**
 * Why an attempt ended `infra_error`, as a name from a small closed set. The kind is carried next
 * to the reason (whose text is unchanged) so the scheduler can decide whether one retry is worth
 * it. This table is the only place that says which kinds are transient.
 */
export const INFRA_KINDS = {
  /** The sandbox's Docker daemon never came up (`docker info` failed). */
  docker_daemon_unavailable: {
    transient: true,
    label: "the sandbox's Docker daemon was unavailable",
  },
  /** The provider could not create the sandbox. */
  sandbox_create_failed: { transient: true, label: "the sandbox could not be created" },
  /** The sandbox or the act process in it vanished before a result. */
  sandbox_lost: { transient: true, label: "the sandbox was lost" },
  /** Reserved for a rate-limited image pull (#513): nothing produces it yet. */
  image_pull_rate_limited: { transient: true, label: "an image pull was rate limited" },
  /** Everything else: a deterministic or unknown cause. Never retried. */
  other: { transient: false, label: "an infrastructure error" },
} as const satisfies Record<string, { transient: boolean; label: string }>;

export type InfraKind = keyof typeof INFRA_KINDS;

export function isInfraKind(v: unknown): v is InfraKind {
  return typeof v === "string" && Object.hasOwn(INFRA_KINDS, v);
}

/** True for a kind worth one retry on a fresh sandbox. */
export function isTransientInfra(kind: InfraKind | null | undefined): boolean {
  return kind != null && INFRA_KINDS[kind].transient;
}
