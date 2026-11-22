// Everything `longshore serve` takes on the command line can also come from the environment, so a
// platform with no shell (Railway) configures the whole server, worker and provider included,
// from variables alone. A flag, when given, wins over its variable.
import { type PollConfig, loadPollConfig, parsePollConfig } from "./poll/config";
import { loadProviderConfig, parseProviderConfig } from "./scheduler/providers";

type Env = Record<string, string | undefined>;

/** The poll config comes from this variable when no file is named: a JSON document. */
export const POLL_JSON_ENV = "LONGSHORE_POLL_JSON";
/** The provider config comes from this variable when no file is named: a JSON object. */
export const PROVIDER_JSON_ENV = "LONGSHORE_PROVIDER_CONFIG_JSON";
/** Stands for "the config is in the environment" wherever a path would go. */
export const ENV_POLL_SOURCE = `env:${POLL_JSON_ENV}`;
export const ENV_PROVIDER_SOURCE = `env:${PROVIDER_JSON_ENV}`;

const flag = (v: string | undefined): boolean => v === "1" || v?.toLowerCase() === "true";

/** The defaults for `serve`'s options, from the environment. */
export function serveDefaults(env: Env): {
  port: string;
  host: string;
  dataDir: string;
  roles: string | undefined;
  worker: boolean;
  globalCap: string;
  orgCap: string;
  leaseSeconds: string;
  image: string | undefined;
  poll: string | undefined;
  provider: string;
  providerConfig: string | undefined;
  hosted: boolean;
  isolationOverride: string | undefined;
} {
  const t = (n: string): string | undefined => env[n]?.trim() || undefined;
  return {
    port: t("PORT") ?? "8080",
    host: env.LONGSHORE_HOST ?? "127.0.0.1",
    dataDir: t("LONGSHORE_DATA_DIR") ?? "./data",
    roles: t("LONGSHORE_ROLES"),
    worker: flag(env.LONGSHORE_WORKER),
    globalCap: t("LONGSHORE_GLOBAL_CAP") ?? "4",
    orgCap: t("LONGSHORE_ORG_CAP") ?? "2",
    leaseSeconds: t("LONGSHORE_LEASE_SECONDS") ?? "30",
    image: t("LONGSHORE_IMAGE"),
    poll: t("LONGSHORE_POLL") ?? (t(POLL_JSON_ENV) ? ENV_POLL_SOURCE : undefined),
    provider: t("LONGSHORE_PROVIDER") ?? "docker",
    providerConfig:
      t("LONGSHORE_PROVIDER_CONFIG") ?? (t(PROVIDER_JSON_ENV) ? ENV_PROVIDER_SOURCE : undefined),
    hosted: flag(env.LONGSHORE_HOSTED),
    isolationOverride: t("LONGSHORE_ISOLATION_OVERRIDE"),
  };
}

/** A poll config from a file, or from the environment variable the sentinel names. */
export function resolvePollConfig(
  source: string | undefined,
  env: Env = process.env,
): PollConfig | undefined {
  if (source === undefined) return undefined;
  if (source === ENV_POLL_SOURCE) {
    const text = env[POLL_JSON_ENV]?.trim();
    if (!text) throw new Error(`${POLL_JSON_ENV} is not set`);
    return parsePollConfig(text, POLL_JSON_ENV);
  }
  return loadPollConfig(source);
}

/** A provider config from a file, or from the environment variable the sentinel names. */
export function resolveProviderConfig(
  source: string | undefined,
  env: Env = process.env,
): Record<string, unknown> {
  if (source === ENV_PROVIDER_SOURCE) {
    const text = env[PROVIDER_JSON_ENV]?.trim();
    if (!text) throw new Error(`${PROVIDER_JSON_ENV} is not set`);
    return parseProviderConfig(text, PROVIDER_JSON_ENV);
  }
  return loadProviderConfig(source);
}
