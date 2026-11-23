// Rules for sandboxes created in a shared Daytona account. These are enforced in
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
export const HARD_MAX_LIVE = 10;

/** Auto-stop, auto-delete and the hard TTL are never longer than this. */
export const MAX_TTL_SECONDS = 30 * 60;

/**
 * How the account owner's own CI sandboxes are recognised, set by the operator: the label `key`
 * with one of `values` (for example `project=acme-ci`), or a sandbox that started from a snapshot
 * named one of `values`. Nothing is assumed: with none configured there is no label check.
 * They are only ever counted, never listed back, changed or deleted.
 */
export type OwnerCiLabels = { key: string; values: readonly string[] };

/**
 * True for one of the account owner's CI sandboxes under `labels`: the label `key` set to exactly
 * one of the values, or a sandbox that started from a snapshot with one of those names.
 */
export function isForeignCi(
  s: { labels?: Record<string, string> | undefined; snapshot?: string | undefined },
  labels: OwnerCiLabels | undefined,
): boolean {
  if (!labels) return false;
  if (s.snapshot !== undefined && labels.values.includes(s.snapshot)) return true;
  const v = s.labels?.[labels.key];
  return v !== undefined && labels.values.includes(v);
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

/** The default fleet: the one every config had before `fleet` was an option. */
export const DEFAULT_FLEET = "longshore-dev";

/**
 * A fleet is one instance's own set of sandboxes in a shared Daytona account: the label `<name>=1`
 * and the name prefix `<name>-`. Everything that counts, lists, verifies or deletes "ours" goes
 * through one, so two instances with different fleets (a developer's machine and a hosted shadow
 * in the same org) can never see, count or delete each other's sandboxes. A sandbox is ours only
 * with BOTH the label and the prefix, so a fleet whose name extends another's
 * (`longshore-dev-2` next to `longshore-dev`) is not mistaken for it by either test.
 */
export interface Fleet {
  readonly name: string;
  /** The label key every sandbox of the fleet carries, with `OWN_LABEL_VALUE`. */
  readonly label: string;
  readonly prefix: string;
  ownName(requested: string): string;
  isOwnName(name: string): boolean;
  isOwn(s: { name?: string | undefined; labels?: Record<string, string> | undefined }): boolean;
}

const FLEET_NAME = /^longshore-[a-z0-9]+(-[a-z0-9]+)*$/;

/** A fleet name: lower case, `longshore-` first, letters digits and single hyphens, at most 30 characters. */
export function parseFleetName(name: string): string {
  if (name.length > 30) throw new RangeError("fleet must be at most 30 characters");
  if (!FLEET_NAME.test(name)) {
    throw new RangeError(
      "fleet must be lower case, start with longshore-, and use only letters, digits and single hyphens (for example longshore-shadow)",
    );
  }
  return name;
}

export function makeFleet(name: string = DEFAULT_FLEET): Fleet {
  const fleet = parseFleetName(name);
  const prefix = `${fleet}-`;
  const isOwnName = (n: string): boolean => n.startsWith(prefix);
  return {
    name: fleet,
    label: fleet,
    prefix,
    isOwnName,
    ownName(requested) {
      const slug = requested
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 63 - prefix.length);
      return `${prefix}${slug === "" ? "sandbox" : slug}`;
    },
    isOwn(s) {
      return (
        s.labels?.[fleet] === OWN_LABEL_VALUE && typeof s.name === "string" && isOwnName(s.name)
      );
    },
  };
}

const DEFAULT = makeFleet();

/** A DNS-label-safe sandbox name that always starts with the default fleet's prefix. */
export const ownName = (requested: string): string => DEFAULT.ownName(requested);

export const isOwnName = (name: string): boolean => DEFAULT.isOwnName(name);

/** True when the sandbox's labels say it is the DEFAULT fleet's AND its name has that prefix. */
export const isOwn = (s: {
  name?: string | undefined;
  labels?: Record<string, string> | undefined;
}): boolean => DEFAULT.isOwn(s);

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
