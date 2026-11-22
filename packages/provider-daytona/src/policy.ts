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
 * Names that mark the account owner's own CI sandboxes. They appear as a label value (for
 * example `project=squirrel-pub-ci`), as a label key, or as the snapshot a sandbox started from.
 * Before creating one of ours, if this many or more of them are running, we wait: our runs must
 * not crowd out their CI. They are only ever counted, never listed back, changed or deleted.
 */
export const FOREIGN_CI_LABELS: readonly string[] = [
  "squirrel-pub-ci",
  "squirrel-ci",
  "squirrel-release",
];
export const FOREIGN_WAIT_AT = 8;

/** The label key the account owner's CI uses, with one of FOREIGN_CI_LABELS as its value. */
export const FOREIGN_CI_LABEL_KEY = "project";

/**
 * True for one of the account owner's CI sandboxes: the label `project` set to exactly one of
 * the CI names, or a sandbox that started from a snapshot with one of those names.
 */
export function isForeignCi(s: {
  labels?: Record<string, string> | undefined;
  snapshot?: string | undefined;
}): boolean {
  if (s.snapshot !== undefined && FOREIGN_CI_LABELS.includes(s.snapshot)) return true;
  const v = s.labels?.[FOREIGN_CI_LABEL_KEY];
  return v !== undefined && FOREIGN_CI_LABELS.includes(v);
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
