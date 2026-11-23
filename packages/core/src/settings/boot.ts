// Builds the settings runtime at boot (#321): the shipped registry, the process environment and
// the file `--config` or `TURNTABLE_CONFIG` names. Every layer above the database is checked
// here, so an unknown key, a bad value or an unreadable file stops the boot naming the key and
// where it was set. No file at all is fine.
import { settingsRegistry } from "./definitions";
import type { SettingsRegistry } from "./define";
import { createSettingsRuntime, type SettingsRuntime, validateEnv } from "./resolve";
import { loadTomlSettings } from "./toml";

/** The config file's path: the flag, else `TURNTABLE_CONFIG`, else none. */
export function configPath(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  return flag?.trim() || env.TURNTABLE_CONFIG?.trim() || undefined;
}

export function loadSettingsRuntime(
  opts: {
    config?: string | undefined;
    env?: Record<string, string | undefined>;
    registry?: SettingsRegistry;
    read?: (path: string) => string;
  } = {},
): SettingsRuntime {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? settingsRegistry;
  const toml = loadTomlSettings(configPath(opts.config, env), registry, opts.read);
  const rt = createSettingsRuntime(registry, env, toml);
  validateEnv(rt);
  return rt;
}
