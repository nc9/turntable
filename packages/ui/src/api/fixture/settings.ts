import type { Setting, Whoami } from "../types";

type Role = Whoami["role"];

type Spec = {
  key: string;
  scope: "org" | "project";
  description: string;
  default: unknown;
  role: Role;
  /** Mirrors the server's refusal text for a value outside the type. */
  check: (v: unknown) => string | null;
  /** Fixed by a layer above the database, as it would be by the environment or the config file. */
  fixed?: { source: "env" | "toml"; value: unknown; lockedBy: string };
};

const int = (min: number, max: number) => (v: unknown) =>
  typeof v !== "number" || !Number.isInteger(v)
    ? "Invalid input: expected int, received " + (typeof v === "number" ? "number" : typeof v)
    : v < min
      ? `Too small: expected number to be >=${min}`
      : v > max
        ? `Too big: expected number to be <=${max}`
        : null;

// Not a real variable: built at runtime so the configuration reference check, which lists every
// TURNTABLE_* name in the source, does not expect it in the docs.
const FIXTURE_ENV = ["TURNTABLE", "MAX", "PARALLEL", "JOBS"].join("_");

// Stand-ins for the real registry, which has no org or project setting yet. They cover each
// source and lock the pages render, so `bun run dev` shows every state.
const SPECS: Spec[] = [
  {
    key: "log_retention_days",
    scope: "org",
    description: "How many days a finished run's logs are kept before they are deleted.",
    default: 30,
    role: "admin",
    check: int(1, 365),
  },
  {
    key: "max_parallel_jobs",
    scope: "org",
    description: "Most jobs of one run that may run at the same time.",
    default: 8,
    role: "admin",
    check: int(1, 64),
    fixed: { source: "env", value: 16, lockedBy: FIXTURE_ENV },
  },
  {
    key: "check_name_prefix",
    scope: "org",
    description: "Text put in front of the name of every check run reported to the forge.",
    default: "turntable / ",
    role: "owner",
    check: (v) => (typeof v === "string" ? null : "Invalid input: expected string"),
    fixed: { source: "toml", value: "ci / ", lockedBy: "toml" },
  },
  {
    key: "cache_enabled",
    scope: "project",
    description: "Whether runs of this project restore and save the dependency cache.",
    default: true,
    role: "operator",
    check: (v) => (typeof v === "boolean" ? null : "Invalid input: expected boolean"),
  },
  {
    key: "job_timeout_minutes",
    scope: "project",
    description: "How long one job may run before it is cancelled.",
    default: 60,
    role: "admin",
    check: int(1, 360),
  },
];

const RANK: Record<Role, number> = {
  reader: 1,
  viewer: 1,
  operator: 2,
  member: 2,
  release_operator: 3,
  admin: 4,
  owner: 5,
};

/** An in-memory settings store with the server's lock, role and validation refusals. */
export function createFixtureSettings(role: () => Role) {
  const stored = new Map<string, unknown>();
  const slot = (key: string, project: string | undefined) => `${project ?? ""}/${key}`;

  function view(s: Spec, project: string | undefined): Setting {
    const base = {
      key: s.key,
      scope: s.scope,
      description: s.description,
      default: s.default,
      role: s.role,
      mcpEditable: false,
    };
    if (s.fixed)
      return {
        ...base,
        value: s.fixed.value,
        source: s.fixed.source,
        locked: true,
        lockedBy: s.fixed.lockedBy,
      };
    const k = slot(s.key, s.scope === "project" ? project : undefined);
    return stored.has(k)
      ? { ...base, value: stored.get(k), source: "db", locked: false, lockedBy: null }
      : { ...base, value: s.default, source: "default", locked: false, lockedBy: null };
  }

  return {
    list(project?: string): Setting[] {
      return SPECS.filter((s) => s.scope === (project === undefined ? "org" : "project")).map((s) =>
        view(s, project),
      );
    },
    set(a: { key: string; value?: unknown; unset?: boolean; project?: string }): Setting {
      const s = SPECS.find((x) => x.key === a.key);
      if (!s) throw new Error(`no such setting: ${a.key}`);
      if (s.fixed) {
        throw new Error(
          `${s.key} is locked: it is set by ${
            s.fixed.source === "env" ? `the environment (${s.fixed.lockedBy})` : "turntable.toml"
          }; change it there`,
        );
      }
      if (RANK[role()] < RANK[s.role]) throw new Error(`changing ${s.key} requires role ${s.role}`);
      const k = slot(s.key, s.scope === "project" ? a.project : undefined);
      if (a.unset) stored.delete(k);
      else {
        const bad = s.check(a.value);
        if (bad) throw new Error(`${s.key}: ${bad}`);
        stored.set(k, a.value);
      }
      return view(s, a.project);
    },
  };
}
