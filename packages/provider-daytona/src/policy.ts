// Customer-account rules for sandboxes created in a shared Daytona account. These are enforced in
// code, not by convention: a spec or option that would break one is refused before any request.

/** Every sandbox we create carries this label, and only sandboxes carrying it are ever listed or deleted. */
export const OWN_LABEL = "longshore-dev";
export const OWN_LABEL_VALUE = "1";
/** Label naming the run a sandbox belongs to. */
export const RUN_LABEL = "longshore-run";
/** Every sandbox we create is named with this prefix. */
export const NAME_PREFIX = "longshore-dev-";

/** Live sandboxes of ours at once. The default is 2; options can lower it, never past the ceiling. */
export const DEFAULT_MAX_LIVE = 2;
export const HARD_MAX_LIVE = 3;

/** Auto-stop, auto-delete and the hard TTL are never longer than this. */
export const MAX_TTL_SECONDS = 30 * 60;

/**
 * How to recognise the account owner's own CI sandboxes, when the operator wants the provider to
 * count them: one label key and the values it takes on those sandboxes (for example
 * `project=acme-ci`), or a snapshot of one of those names. Nothing is assumed: with no
 * `ownerCiLabels` configured there is no label check at all. They are only ever counted, never
 * listed back, changed or deleted.
 */
export interface OwnerCiLabels {
  /** The label key their CI sandboxes carry, for example `project`. */
  key: string;
  /** The values of that key (and snapshot names) that mark a sandbox as theirs. */
  values: readonly string[];
}

const LABEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Validates an `OwnerCiLabels`; throws a RangeError naming what is wrong. */
export function checkOwnerCiLabels(l: OwnerCiLabels): OwnerCiLabels {
  if (!LABEL_NAME.test(l.key)) throw new RangeError("ownerCiLabels.key must be a plain label name");
  if (l.values.length < 1 || l.values.length > 20)
    throw new RangeError("ownerCiLabels.values must list 1 to 20 values");
  for (const v of l.values)
    if (!LABEL_NAME.test(v)) throw new RangeError(`ownerCiLabels.values entry ${v} is not plain`);
  return { key: l.key, values: [...new Set(l.values)] };
}

/**
 * True for one of the account owner's CI sandboxes: the configured label key set to exactly one of
 * the configured values, or a sandbox that started from a snapshot with one of those names.
 */
export function isOwnerCi(
  s: { labels?: Record<string, string> | undefined; snapshot?: string | undefined },
  l: OwnerCiLabels,
): boolean {
  if (s.snapshot !== undefined && l.values.includes(s.snapshot)) return true;
  const v = s.labels?.[l.key];
  return v !== undefined && l.values.includes(v);
}

/**
 * Every Daytona sandbox state. A sandbox holds quota in all of them except the four in
 * `FREE_STATES`: stopped, archived, destroyed and error. Everything else, including the
 * transitional states (creating, restoring, stopping, destroying, ...), counts as live.
 */
export const ALL_STATES: readonly string[] = [
  "creating",
  "restoring",
  "destroyed",
  "destroying",
  "started",
  "stopped",
  "starting",
  "stopping",
  "error",
  "build_failed",
  "pending_build",
  "building_snapshot",
  "unknown",
  "pulling_snapshot",
  "archived",
  "archiving",
  "resizing",
  "snapshotting",
  "forking",
  "pausing",
  "paused",
  "resuming",
];

/** States that hold no quota. */
export const FREE_STATES: readonly string[] = ["stopped", "archived", "destroyed", "error"];

/** The states asked for when counting live sandboxes (everything that holds quota). */
export const LIVE_STATES: readonly string[] = ALL_STATES.filter((s) => !FREE_STATES.includes(s));

/** A state we do not recognise is counted as live: when unsure, assume it holds quota. */
export const isLive = (state: string | undefined): boolean =>
  state !== undefined && !FREE_STATES.includes(state);

/** A DNS-label-safe sandbox name that always starts with the required prefix. */
export function ownName(requested: string): string {
  const slug = requested
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 63 - NAME_PREFIX.length);
  return `${NAME_PREFIX}${slug === "" ? "sandbox" : slug}`;
}

export const isOwnName = (name: string): boolean => name.startsWith(NAME_PREFIX);

/** True when the sandbox's labels say it is ours AND its name has our prefix. */
export function isOwn(s: {
  name?: string | undefined;
  labels?: Record<string, string> | undefined;
}): boolean {
  return (
    s.labels?.[OWN_LABEL] === OWN_LABEL_VALUE && typeof s.name === "string" && isOwnName(s.name)
  );
}

export function clampMaxLive(requested: number | undefined): number {
  const n = requested ?? DEFAULT_MAX_LIVE;
  if (!Number.isInteger(n) || n < 1) throw new RangeError("maxLive must be a positive integer");
  if (n > HARD_MAX_LIVE) {
    throw new RangeError(
      `maxLive ${n} exceeds the hard ceiling of ${HARD_MAX_LIVE}; raising it needs a code change`,
    );
  }
  return n;
}

/**
 * The org-wide check before a create. The account's quota is shared with other users of the same
 * org, whose sandboxes carry no label we know, so the label count above cannot see them. The org's
 * usage endpoint can: before creating one of ours we read the CPU in use in one region and sandbox
 * class and wait while ours would push it past `cpuLimit`.
 */
export interface OwnerCiPreflight {
  /** Wait while current usage plus this sandbox's vCPU is above this. Default 200 (the quota is 250). */
  cpuLimit?: number;
  /** Default `us`. */
  region?: string;
  /** Default `container`. */
  sandboxClass?: string;
}

export const DEFAULT_ORG_CPU_LIMIT = 200;
export const DEFAULT_ORG_REGION = "us";
export const DEFAULT_ORG_CLASS = "container";

/** One row of the usage reply we read. */
export interface RegionUsageRow {
  regionId?: string;
  sandboxClass?: string;
  currentCpuUsage?: number;
}

/**
 * The vCPU in use in the region and class, from the usage reply. No row means nothing is running
 * there (0). A row without a number is not a reading: undefined, which the caller treats as an
 * error rather than as room.
 */
export function cpuInUse(
  rows: readonly RegionUsageRow[] | undefined,
  region: string,
  sandboxClass: string,
): number | undefined {
  const row = rows?.find((r) => r.regionId === region && r.sandboxClass === sandboxClass);
  if (row === undefined) return 0;
  return typeof row.currentCpuUsage === "number" ? row.currentCpuUsage : undefined;
}
