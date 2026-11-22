/**
 * Workflow trigger router. act ignores `on:` filters, so Longshore evaluates them: event names,
 * branch and tag filters, path filters, and activity types.
 */

export interface WorkflowEvent {
  /** push, pull_request, merge_group, workflow_dispatch ... */
  name: string;
  /** Full ref of the commit: refs/heads/main or refs/tags/v1. */
  ref?: string;
  /** Base branch name for pull_request, pull_request_target and merge_group. */
  baseRef?: string;
  /** Activity type, for example opened. Defaults are applied when absent. */
  action?: string;
  /** Files the change touches. Undefined means unknown. */
  changedFiles?: readonly string[];
}

export interface TriggerResult {
  matched: boolean;
  reason: string;
  /** A path filter exists but changed files were not provided, so it was not applied. */
  pathsUnknown?: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | undefined =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v) && v.every((x) => typeof x === "string")
      ? v
      : undefined;

/** Converts a GitHub filter pattern to a regular expression. */
export function patternToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (c === "*") {
      out += "[^/]*";
      i += 1;
    } else if (c === "?" || c === "+") {
      // Applies to the preceding character: zero-or-one, or one-or-more.
      out += c;
      i += 1;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) {
        out += "\\[";
        i += 1;
      } else {
        out += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      out += c.replaceAll(/[.^${}()|\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Applies an ordered pattern list with `!` negation: the last matching pattern decides.
 * True when `value` is included.
 */
export function matchesPatterns(patterns: readonly string[], value: string): boolean {
  let included = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (patternToRegExp(p.slice(1)).test(value)) included = false;
    } else if (patternToRegExp(p).test(value)) {
      included = true;
    }
  }
  return included;
}

function filterList(cfg: Obj, key: string): string[] | undefined {
  return cfg[key] === undefined ? undefined : strings(cfg[key]);
}

function refFilter(
  cfg: Obj,
  value: string | undefined,
  include: string,
  ignore: string,
): { ok: boolean; what: string } | undefined {
  const inc = filterList(cfg, include);
  const ign = filterList(cfg, ignore);
  if (!inc && !ign) return undefined;
  if (value === undefined) return { ok: false, what: `no ref for ${include}` };
  if (inc) return { ok: matchesPatterns(inc, value), what: `${include} ${inc.join(", ")}` };
  return {
    ok: !matchesPatterns(ign as string[], value),
    what: `${ignore} ${(ign as string[]).join(", ")}`,
  };
}

const PR_DEFAULT_TYPES = ["opened", "synchronize", "reopened"];

/** Decides whether a workflow's `on:` triggers for an event. */
export function matchTrigger(on: unknown, event: WorkflowEvent): TriggerResult {
  let cfg: unknown;
  if (typeof on === "string") {
    cfg = on === event.name ? {} : undefined;
  } else if (Array.isArray(on)) {
    cfg = on.includes(event.name) ? {} : undefined;
  } else if (isObj(on)) {
    cfg = event.name in on ? (on[event.name] ?? {}) : undefined;
  }
  if (cfg === undefined)
    return { matched: false, reason: `workflow does not trigger on ${event.name}` };
  const c = isObj(cfg) ? cfg : {};

  const isPr = ["pull_request", "pull_request_target", "merge_group"].includes(event.name);
  const branch = event.ref?.startsWith("refs/heads/")
    ? event.ref.slice("refs/heads/".length)
    : undefined;
  const tag = event.ref?.startsWith("refs/tags/")
    ? event.ref.slice("refs/tags/".length)
    : undefined;

  if (event.name === "push") {
    const hasBranches = c.branches !== undefined || c["branches-ignore"] !== undefined;
    const hasTags = c.tags !== undefined || c["tags-ignore"] !== undefined;
    if (tag !== undefined && hasBranches && !hasTags) {
      return { matched: false, reason: "tag push, but only branch filters are set" };
    }
    if (branch !== undefined && hasTags && !hasBranches) {
      return { matched: false, reason: "branch push, but only tag filters are set" };
    }
    const b =
      branch === undefined ? undefined : refFilter(c, branch, "branches", "branches-ignore");
    if (b && !b.ok) return { matched: false, reason: `branch ${branch} fails ${b.what}` };
    const t = tag === undefined ? undefined : refFilter(c, tag, "tags", "tags-ignore");
    if (t && !t.ok) return { matched: false, reason: `tag ${tag} fails ${t.what}` };
  } else if (isPr) {
    const b = refFilter(c, event.baseRef, "branches", "branches-ignore");
    if (b && !b.ok)
      return { matched: false, reason: `base ${event.baseRef ?? "?"} fails ${b.what}` };
    if (event.name !== "merge_group") {
      const types = strings(c.types) ?? PR_DEFAULT_TYPES;
      if (event.action !== undefined && !types.includes(event.action)) {
        return {
          matched: false,
          reason: `activity type ${event.action} is not in ${types.join(", ")}`,
        };
      }
    }
  }

  const paths = filterList(c, "paths");
  const ignore = filterList(c, "paths-ignore");
  if ((paths || ignore) && (event.name === "push" || isPr)) {
    if (event.changedFiles === undefined) {
      return {
        matched: true,
        reason: "path filters not applied: changed files unknown",
        pathsUnknown: true,
      };
    }
    const files = event.changedFiles;
    if (paths) {
      const hit = files.some((f) => matchesPatterns(paths, f));
      if (!hit)
        return { matched: false, reason: `no changed file matches paths ${paths.join(", ")}` };
    } else if (ignore && files.length > 0 && files.every((f) => matchesPatterns(ignore, f))) {
      return {
        matched: false,
        reason: `every changed file matches paths-ignore ${ignore.join(", ")}`,
      };
    }
  }
  return { matched: true, reason: `triggers on ${event.name}` };
}
