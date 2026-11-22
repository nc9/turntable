import { readFileSync } from "node:fs";
import { DockerProvider } from "@longshore/provider-docker";
import type { Provider } from "@longshore/provider-sdk";

/** Providers `serve --provider` knows. Daytona is wired in when its package lands. */
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
      throw new Error(
        "the daytona provider is not available in this build yet; use --provider docker",
      );
  }
}
