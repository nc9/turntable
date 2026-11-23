// The settings registry (#321): every setting is defined once, here, the way an operation is
// defined once in ops/. The one definition drives the `turntable.toml` schema, the get and set
// ops, the resolver's validation and the generated configuration reference.
import { z } from "zod";
import type { Role } from "../ops/roles";
import { ROLE_RANK } from "../ops/roles";
import type { SettingScope } from "../db/schema";

/** Who may change a setting: an org role, or the instance administrator for instance settings. */
export type SettingRole = Role | "instance_admin";

export type SettingSpec<T> = {
  /** snake_case, unique. The `key` of `get_setting` and `set_setting`. */
  key: string;
  scope: SettingScope;
  /** Validates every value, whichever layer it came from. */
  type: z.ZodType<T>;
  default: T;
  /**
   * A value `type` accepts but that may not be selected yet: returns the reason. Enforced on
   * every path that sets a value (the ops, the CLI, the config file and the environment), never
   * on reading what is already stored, so a stored value still fails closed.
   */
  refuse?: (value: T) => string | undefined;
  /** The least role that may change it: `instance_admin` for instance settings, else an org role. */
  role: SettingRole;
  /**
   * An org or project setting only the instance administrator may change, whatever `role` says:
   * `set_setting` refuses every org token and the instance op that aliases the setting is the
   * way in. For settings that widen what a tenant's runs may do.
   */
  instanceAdminOnly?: boolean;
  /**
   * The values of an enum setting from least to most strict. Only meaningful with
   * `instanceAdminOnly`, which it relaxes one way: `instanceAdminOnly` alone means every change
   * needs the instance administrator, while with `strictness` an org principal holding `role`
   * may set a value at least as strict as the current effective one (a reset counts as setting
   * the default). Loosening stays the instance administrator's. For limit-type settings.
   */
  strictness?: readonly string[];
  /**
   * Whether `set_setting` may change it over MCP. False for anything that raises a limit or
   * widens what a run may do: a value in an agent's context is not a human decision (#188).
   */
  mcpEditable: boolean;
  /** Required when `mcpEditable` is false: shown to the caller who is refused. */
  mcpReason?: string;
  description: string;
  /**
   * Shown with the setting wherever it is displayed (the web UI's settings panel): what is at
   * risk in changing it. For settings whose change can weaken a protection.
   */
  warning?: string;
  /**
   * The parts of a change that weaken a protection, in words, empty when none. A change that
   * returns any is audited with them (in every chain the change is written to) and emits an
   * event, on every path that writes the value.
   */
  loosens?: (before: T, after: T) => string[];
  /** Environment variables that set it. The first is the canonical name. */
  env?: readonly string[];
  /** Turns the raw text of an environment variable into a value for `type`; text by default. */
  envParse?: (raw: string) => unknown;
  /**
   * Dotted path inside its `turntable.toml` section: `backup.keep` is `keep` in `[backup]`.
   * Instance settings sit at the top level, org settings under `[orgs.<slug>]` and project
   * settings under `[orgs.<slug>.projects.<slug>]`.
   */
  toml: string;
};

export type SettingDef = Omit<SettingSpec<unknown>, "env"> & { env: readonly string[] };

export type SettingsRegistry = {
  readonly settings: readonly SettingDef[];
  get(key: string): SettingDef | undefined;
  byScope(scope: SettingScope): SettingDef[];
};

const KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const TOML_PATH = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Secrets never live in settings: they go to the vault. A name that says otherwise is refused. */
const SECRETISH = /secret|token|password|passwd|credential|private_key|api_key|apikey/i;
/** Top-level TOML keys that name a section, not a setting. */
const RESERVED_TOML = new Set(["orgs", "projects"]);

export function defineSetting<T>(spec: SettingSpec<T>): SettingDef {
  const k = spec.key;
  if (!KEY.test(k)) throw new Error(`setting key must be snake_case: ${k}`);
  if (SECRETISH.test(k) || SECRETISH.test(spec.toml)) {
    throw new Error(`${k}: secrets are never settings; use the vault`);
  }
  if ((spec as { secret?: unknown }).secret) throw new Error(`${k}: no setting may be secret`);
  if (spec.description.length < 20) throw new Error(`${k}: description must say what it does`);
  if (!TOML_PATH.test(spec.toml)) throw new Error(`${k}: toml must be a dotted lower-case path`);
  if (RESERVED_TOML.has(spec.toml.split(".")[0]!)) {
    throw new Error(`${k}: toml path may not start with a section name`);
  }
  for (const e of spec.env ?? []) {
    if (!ENV_NAME.test(e)) throw new Error(`${k}: bad environment variable name ${e}`);
    if (SECRETISH.test(e)) throw new Error(`${k}: secrets are never settings; use the vault`);
  }
  if (spec.scope === "instance") {
    if (spec.role !== "instance_admin") {
      throw new Error(`${k}: an instance setting is changed by the instance administrator`);
    }
  } else if (spec.role === "instance_admin" || !(spec.role in ROLE_RANK)) {
    throw new Error(`${k}: an ${spec.scope} setting needs an org role`);
  }
  if (!spec.mcpEditable && !spec.mcpReason) {
    throw new Error(`${k}: a setting MCP may not change needs an mcpReason`);
  }
  if (spec.strictness) {
    if (!spec.instanceAdminOnly) {
      throw new Error(`${k}: strictness needs instanceAdminOnly (it relaxes it one way)`);
    }
    if (new Set(spec.strictness).size !== spec.strictness.length || spec.strictness.length < 2) {
      throw new Error(`${k}: strictness lists at least two distinct values`);
    }
    for (const v of spec.strictness) {
      if (!spec.type.safeParse(v).success)
        throw new Error(`${k}: strictness value ${v} is not valid`);
    }
    if (!spec.strictness.includes(spec.default as string)) {
      throw new Error(`${k}: the default is not in strictness`);
    }
  }
  const bad = spec.type.safeParse(spec.default);
  if (!bad.success) throw new Error(`${k}: the default does not satisfy its own type`);
  return { ...spec, env: spec.env ?? [] } as SettingDef;
}

/** Builds a registry. A value, not a global, so tests can add settings the shipped one never has. */
export function createSettingsRegistry(settings: readonly SettingDef[]): SettingsRegistry {
  const byKey = new Map<string, SettingDef>();
  const paths = new Map<string, string>();
  const envNames = new Map<string, string>();
  for (const d of settings) {
    if (byKey.has(d.key)) throw new Error(`duplicate setting key: ${d.key}`);
    byKey.set(d.key, d);
    // One TOML section per scope: two settings of a scope cannot share a path, or one be the
    // parent table of another.
    for (const [other, otherPath] of paths) {
      const [otherScope, p] = [other.split(":")[0], otherPath];
      if (otherScope !== d.scope) continue;
      if (p === d.toml || p.startsWith(`${d.toml}.`) || d.toml.startsWith(`${p}.`)) {
        throw new Error(`${d.key}: toml path ${d.toml} clashes with ${p}`);
      }
    }
    paths.set(`${d.scope}:${d.key}`, d.toml);
    for (const e of d.env) {
      if (envNames.has(e)) throw new Error(`${d.key}: ${e} already sets ${envNames.get(e)}`);
      envNames.set(e, d.key);
    }
  }
  return {
    settings,
    get: (key) => byKey.get(key),
    byScope: (scope) => settings.filter((d) => d.scope === scope),
  };
}

/** A short human description of a setting's type, from its schema, for the generated docs. */
export function describeType(def: SettingDef): string {
  const j = z.toJSONSchema(def.type, { target: "draft-2020-12", io: "input" }) as {
    type?: string;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
    minLength?: number;
    maxLength?: number;
  };
  if (j.enum) return `one of ${j.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  const t = j.type === "integer" ? "whole number" : (j.type ?? "value");
  if (j.minimum !== undefined && j.maximum !== undefined)
    return `${t}, ${j.minimum} to ${j.maximum}`;
  if (j.minimum !== undefined) return `${t}, at least ${j.minimum}`;
  if (j.maximum !== undefined) return `${t}, at most ${j.maximum}`;
  if (j.maxLength !== undefined) return `${t}, up to ${j.maxLength} characters`;
  return t;
}
