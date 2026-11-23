// The one resolver (#321): environment, then `turntable.toml`, then the database, then the
// default. Everything that reads a setting, the ops and the code that uses its value, goes
// through here, so what an operator is shown is what the server does.
import type { Db } from "../db";
import { getStoredSetting, type SettingTarget } from "../db/repos/settings";
import type { SettingDef, SettingsRegistry } from "./define";
import { EMPTY_TOML, SettingsConfigError, type TomlLayer } from "./toml";

export type SettingSource = "env" | "toml" | "db" | "default";

export type Resolved = {
  key: string;
  value: unknown;
  source: SettingSource;
  /** Set by the environment or the config file: the ops and the UI cannot change it. */
  locked: boolean;
  /** For a locked value, where it came from: the variable name or the file. */
  origin?: string;
};

type Env = Record<string, string | undefined>;

/** What a resolver reads besides the database. Built once at boot. */
export type SettingsRuntime = {
  registry: SettingsRegistry;
  env: Env;
  toml: TomlLayer;
};

/** Who an org or project setting is about. Slugs are what `turntable.toml` is keyed by. */
export type SettingSubject = {
  orgId?: string;
  orgSlug?: string;
  projectId?: string;
  projectSlug?: string;
};

export function createSettingsRuntime(
  registry: SettingsRegistry,
  env: Env = {},
  toml: TomlLayer = EMPTY_TOML,
): SettingsRuntime {
  return { registry, env, toml };
}

/** The environment layer's value for a setting: the first variable that is set and not empty. */
export function envValue(def: SettingDef, env: Env): { name: string; value: unknown } | undefined {
  for (const name of def.env) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const parsed = def.type.safeParse(def.envParse ? def.envParse(raw) : raw);
    if (!parsed.success) {
      throw new SettingsConfigError(
        `${name} (setting ${def.key}): ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    return { name, value: parsed.data };
  }
  return undefined;
}

/** Fails at boot on a bad environment value, naming the variable and the setting. */
export function validateEnv(rt: SettingsRuntime): void {
  for (const def of rt.registry.settings) envValue(def, rt.env);
}

function tomlValue(
  def: SettingDef,
  toml: TomlLayer,
  subject: SettingSubject,
): { value: unknown } | undefined {
  const section =
    def.scope === "instance"
      ? toml.instance
      : def.scope === "org"
        ? subject.orgSlug
          ? toml.orgs.get(subject.orgSlug)
          : undefined
        : subject.orgSlug && subject.projectSlug
          ? toml.projects.get(`${subject.orgSlug}/${subject.projectSlug}`)
          : undefined;
  return section?.has(def.key) ? { value: section.get(def.key) } : undefined;
}

/** The database row's target for a setting about `subject`. */
export function storeTarget(def: SettingDef, subject: SettingSubject): SettingTarget {
  if (def.scope === "instance") return { kind: "instance", id: "", orgId: null };
  if (def.scope === "org") {
    if (!subject.orgId) throw new Error(`${def.key} is an org setting: an org is needed`);
    return { kind: "org", id: subject.orgId, orgId: subject.orgId };
  }
  if (!subject.projectId) throw new Error(`${def.key} is a project setting: a project is needed`);
  if (!subject.orgId) throw new Error(`${def.key} is a project setting: an org is needed`);
  return { kind: "project", id: subject.projectId, orgId: subject.orgId };
}

/** The environment and file layers: the ones that lock a setting. */
function lockedLayer(
  rt: SettingsRuntime,
  def: SettingDef,
  subject: SettingSubject,
): Resolved | undefined {
  const e = envValue(def, rt.env);
  if (e) return { key: def.key, value: e.value, source: "env", locked: true, origin: e.name };
  const t = tomlValue(def, rt.toml, subject);
  if (!t) return undefined;
  return {
    key: def.key,
    value: t.value,
    source: "toml",
    locked: true,
    ...(rt.toml.file ? { origin: rt.toml.file } : {}),
  };
}

function definition(rt: SettingsRuntime, key: string): SettingDef {
  const def = rt.registry.get(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  return def;
}

/**
 * The effective value of one setting. A stored value that no longer satisfies the setting's type
 * is ignored with a warning, never used.
 */
export async function resolveSetting(
  rt: SettingsRuntime,
  db: Db,
  key: string,
  subject: SettingSubject = {},
): Promise<Resolved> {
  const def = definition(rt, key);
  const locked = lockedLayer(rt, def, subject);
  if (locked) return locked;
  const stored = await getStoredSetting(db, storeTarget(def, subject), key);
  if (stored) {
    const r = def.type.safeParse(stored.value);
    if (r.success) return { key, value: r.data, source: "db", locked: false };
    console.warn(`turntable: ignoring the stored value of setting ${key}: it is no longer valid`);
  }
  return { key, value: def.default, source: "default", locked: false };
}

/**
 * The layers above the database, for code that runs before the database is open (the backup
 * taken before a migration). Never reports a database value: it may not have been read.
 */
export function resolveSettingBeforeDb(
  rt: SettingsRuntime,
  key: string,
  subject: SettingSubject = {},
): Resolved {
  const def = definition(rt, key);
  return (
    lockedLayer(rt, def, subject) ?? { key, value: def.default, source: "default", locked: false }
  );
}
