import { readFileSync } from "node:fs";
import { DaytonaProvider, HARD_MAX_LIVE } from "@longshore/provider-daytona";
import { DockerProvider } from "@longshore/provider-docker";
import type { Provider } from "@longshore/provider-sdk";

/** Providers `serve --provider` knows. */
export const PROVIDER_NAMES = ["docker", "daytona"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(name: string): name is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * Reads a provider config file: a JSON object of provider options. Secrets do not go in it:
 * a provider that needs an API key reads it from a file named here (never inline).
 */
export function loadProviderConfig(path: string | undefined): Record<string, unknown> {
  if (path === undefined) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read provider config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`provider config ${path} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

const DOCKER_KEYS = new Set(["docker", "maxFileBytes"]);

/**
 * Builds the provider named on the command line. It codes against the provider-sdk `Provider`
 * interface only, so the worker never knows which one it has.
 */
export function createProvider(name: string, config: Record<string, unknown> = {}): Provider {
  if (!isProviderName(name)) {
    throw new Error(`unknown provider ${name}; use one of: ${PROVIDER_NAMES.join(", ")}`);
  }
  switch (name) {
    case "docker": {
      const unknown = Object.keys(config).filter((k) => !DOCKER_KEYS.has(k));
      if (unknown.length > 0) {
        throw new Error(
          `unknown docker provider option(s): ${unknown.join(", ")} (known: ${[...DOCKER_KEYS].join(", ")})`,
        );
      }
      return new DockerProvider({
        ...(typeof config.docker === "string" ? { docker: config.docker } : {}),
        ...(typeof config.maxFileBytes === "number" ? { maxFileBytes: config.maxFileBytes } : {}),
      });
    }
    case "daytona":
      return createDaytona(config);
  }
}

const DAYTONA_KEYS = new Set([
  "baseUrl",
  "apiKeyFile",
  "apiKeyEnv",
  "maxLive",
  "snapshot",
  "target",
  "ttlSeconds",
  "capacityWaitSeconds",
  "ownerCiPreflight",
]);

function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "")
    throw new Error(`daytona provider option ${key} must be a non-empty string`);
  return v;
}

function int(
  config: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`daytona provider option ${key} must be an integer from ${min} to ${max}`);
  }
  return v;
}

/**
 * Daytona, for a shared account. The key is never in the config: `apiKeyFile` names a file that
 * holds it (or `apiKeyEnv` an environment variable; default `DAYTONA_API_KEY`). The label and name
 * prefix `longshore-dev`, the 30 minute backstops, the owner-CI preflight and the cap of 3 live
 * sandboxes are fixed in the provider and cannot be configured away.
 */
function createDaytona(config: Record<string, unknown>): Provider {
  const unknown = Object.keys(config).filter((k) => !DAYTONA_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown daytona provider option(s): ${unknown.join(", ")} (known: ${[...DAYTONA_KEYS].join(", ")})`,
    );
  }
  if (config.ownerCiPreflight !== undefined && config.ownerCiPreflight !== true) {
    throw new Error("daytona provider option ownerCiPreflight cannot be turned off");
  }
  if (config.apiKeyFile !== undefined && config.apiKeyEnv !== undefined) {
    throw new Error("set only one of apiKeyFile and apiKeyEnv for the daytona provider");
  }
  const keyFile = str(config, "apiKeyFile");
  const keyEnv = str(config, "apiKeyEnv") ?? "DAYTONA_API_KEY";
  const baseUrl = str(config, "baseUrl");
  const snapshot = str(config, "snapshot");
  const target = str(config, "target");
  const maxLive = int(config, "maxLive", 1, HARD_MAX_LIVE);
  const ttl = int(config, "ttlSeconds", 60, 1800);
  const wait = int(config, "capacityWaitSeconds", 1, 3600);
  return new DaytonaProvider({
    apiKey: keyFile !== undefined ? { file: keyFile } : { env: keyEnv },
    ...(baseUrl ? { baseUrl } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(target ? { target } : {}),
    ...(maxLive !== undefined ? { maxLive } : {}),
    ...(wait !== undefined ? { capacityWaitMs: wait * 1000 } : {}),
    // The scheduler asks for job timeout plus slack, usually past 30 minutes: clamp instead of
    // refusing so jobs still run; the sandbox is reaped at the cap either way.
    clampTtl: true,
    ...(ttl !== undefined ? { maxTtlSeconds: ttl } : {}),
  });
}
