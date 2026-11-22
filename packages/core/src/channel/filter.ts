// What the channel lets through. Everything here is checked before any notification is built.

export const DEFAULT_TYPES = ["run.finished", "approval.required"] as const;
export const DEFAULT_CONCLUSIONS = ["failure", "infra_error"] as const;

export type ChannelFilter = {
  /** Event types to read from the feed. */
  types: readonly string[];
  /** Run conclusions that count for `run.finished`. */
  conclusions: readonly string[];
  /** Project slugs; empty means all. */
  projects: readonly string[];
  /** Branch names or `*` globs; empty means all. */
  branches: readonly string[];
};

export function defaultFilter(): ChannelFilter {
  return {
    types: DEFAULT_TYPES,
    conclusions: DEFAULT_CONCLUSIONS,
    projects: [],
    branches: [],
  };
}

export const splitList = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function glob(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(name);
}

/** Type, conclusion and project, from the event alone (no extra request). */
export function matchesEvent(
  f: ChannelFilter,
  e: { type: string; project: string | null; payload: Record<string, unknown> },
): boolean {
  if (!f.types.includes(e.type)) return false;
  if (e.type === "run.finished") {
    const status = e.payload.status;
    if (typeof status !== "string" || !f.conclusions.includes(status)) return false;
  }
  if (f.projects.length > 0 && (e.project === null || !f.projects.includes(e.project)))
    return false;
  return true;
}

export function filterNeedsBranch(f: ChannelFilter): boolean {
  return f.branches.length > 0;
}

/** Branch filter. An unknown branch never matches a configured branch filter. */
export function matchesBranch(f: ChannelFilter, branch: string | null): boolean {
  if (f.branches.length === 0) return true;
  if (branch === null) return false;
  return f.branches.some((p) => glob(p, branch));
}

/** Parses and validates user input; throws with a message naming the bad value. */
export function buildFilter(
  o: {
    types?: string | undefined;
    conclusions?: string | undefined;
    projects?: string | undefined;
    branches?: string | undefined;
  },
  validTypes: readonly string[],
  validConclusions: readonly string[],
): ChannelFilter {
  const f = defaultFilter();
  const types = splitList(o.types);
  const conclusions = splitList(o.conclusions);
  for (const t of types) if (!validTypes.includes(t)) throw new Error(`unknown event type "${t}"`);
  for (const c of conclusions)
    if (!validConclusions.includes(c)) throw new Error(`unknown conclusion "${c}"`);
  return {
    types: types.length ? types : f.types,
    conclusions: conclusions.length ? conclusions : f.conclusions,
    projects: splitList(o.projects),
    branches: splitList(o.branches),
  };
}
