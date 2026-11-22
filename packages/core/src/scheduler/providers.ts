import { readFileSync } from "node:fs";
import { DaytonaProvider, HARD_MAX_LIVE, type OwnerCiPreflight } from "@longshore/provider-daytona";
import { DockerProvider } from "@longshore/provider-docker";
import type { Provider } from "@longshore/provider-sdk";
import {
  BUILTIN_CEILINGS,
  checkProviderInfo,
  parsePluginPins,
  ProviderTrustError,
  verifyExternalPlugin,
  type PluginPin,
} from "./provider-trust";

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
export function parseProviderConfig(text: string, source: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot read provider config ${source}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`provider config ${source} must be a JSON object`);
  }
  return raw as Record<string, unknown>;
}

export function loadProviderConfig(path: string | undefined): Record<string, unknown> {
  if (path === undefined) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read provider config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  return parseProviderConfig(text, path);
}

const DOCKER_KEYS = new Set(["docker", "maxFileBytes", "runtime"]);

/**
 * Builds the provider named on the command line. It codes against the provider-sdk `Provider`
 * interface only, so the worker never knows which one it has.
 */
export function createProvider(
  name: string,
  config: Record<string, unknown> = {},
  opts: { hosted?: boolean; pins?: readonly PluginPin[] } = {},
): Provider {
  if (!isProviderName(name)) {
    // Not built in: gated by hosted mode and a digest pin, and no external loader exists yet.
    const path = verifyExternalPlugin(name, {
      hosted: opts.hosted === true,
      pins: opts.pins ?? parsePluginPins(process.env.LONGSHORE_PROVIDER_PLUGINS),
    });
    throw new ProviderTrustError(
      `plugin ${name} (${path}) matches its pinned digest, but this build has no external provider loader; use one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
  const provider = build(name, config);
  // The declaration is checked at registration, before the scheduler relies on it.
  checkProviderInfo(name, provider.info, BUILTIN_CEILINGS[name]);
  return provider;
}

function build(name: ProviderName, config: Record<string, unknown>): Provider {
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
        // `runsc` (gVisor) makes the provider declare the gvisor isolation class.
        ...(typeof config.runtime === "string" ? { hardening: { runtime: config.runtime } } : {}),
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
  "ownerCiLabels",
  "ownerCiLabelWaitAt",
  "allowDomainListConfinement",
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
 * `ownerCiPreflight` in the config: `true` (or absent) is the defaults; an object sets the org CPU
 * check's `cpuLimit`, `region` and `sandboxClass`; `false` turns that org check off. The label
 * count of the account owner's CI sandboxes is separate and off unless `ownerCiLabels` and
 * `ownerCiLabelWaitAt` are both given.
 */
function ownerCiPreflightOf(v: unknown): OwnerCiPreflight | false | undefined {
  if (v === undefined || v === true) return undefined;
  if (v === false) return false;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(
      "daytona provider option ownerCiPreflight must be true, false or { cpuLimit, region, sandboxClass }",
    );
  }
  const o = v as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !["cpuLimit", "region", "sandboxClass"].includes(k));
  if (unknown.length > 0) {
    throw new Error(`unknown ownerCiPreflight option(s): ${unknown.join(", ")}`);
  }
  const out: OwnerCiPreflight = {};
  if (o.cpuLimit !== undefined) {
    if (
      typeof o.cpuLimit !== "number" ||
      !Number.isInteger(o.cpuLimit) ||
      o.cpuLimit < 1 ||
      o.cpuLimit > 10_000
    ) {
      throw new Error("ownerCiPreflight.cpuLimit must be an integer from 1 to 10000");
    }
    out.cpuLimit = o.cpuLimit;
  }
  for (const k of ["region", "sandboxClass"] as const) {
    const x = o[k];
    if (x === undefined) continue;
    if (typeof x !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(x)) {
      throw new Error(`ownerCiPreflight.${k} must be a short lower-case name`);
    }
    out[k] = x;
  }
  return out;
}

/** `ownerCiLabels`: `{ key, values[] }`, the label that marks the account owner's CI sandboxes. */
function ownerCiLabelsOf(v: unknown): { key: string; values: string[] } | undefined {
  if (v === undefined) return undefined;
  const bad = (): never => {
    throw new Error(
      "daytona provider option ownerCiLabels must be { key, values }, for example { key: 'project', values: ['acme-ci'] }",
    );
  };
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "key" && k !== "values")) return bad();
  if (typeof o.key !== "string" || !Array.isArray(o.values)) return bad();
  if (!o.values.every((x) => typeof x === "string")) return bad();
  return { key: o.key, values: o.values as string[] };
}

/**
 * Daytona, for a shared account. The key is never in the config: `apiKeyFile` names a file that
 * holds it (or `apiKeyEnv` an environment variable; default `DAYTONA_API_KEY`). The label and name
 * prefix `longshore-dev`, the 30 minute backstops and the cap of 3 live sandboxes are fixed in the
 * provider and cannot be configured away. Counting the account owner's CI sandboxes by label is
 * the operator's to configure (`ownerCiLabels`, `ownerCiLabelWaitAt`) and is off by default.
 */
function createDaytona(config: Record<string, unknown>): Provider {
  const unknown = Object.keys(config).filter((k) => !DAYTONA_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown daytona provider option(s): ${unknown.join(", ")} (known: ${[...DAYTONA_KEYS].join(", ")})`,
    );
  }
  const preflight = ownerCiPreflightOf(config.ownerCiPreflight);
  const ownerLabels = ownerCiLabelsOf(config.ownerCiLabels);
  const labelWaitAt = int(config, "ownerCiLabelWaitAt", 1, 10_000);
  if ((ownerLabels === undefined) !== (labelWaitAt === undefined)) {
    throw new Error(
      "daytona provider options ownerCiLabels and ownerCiLabelWaitAt go together: the labels say what to count, the number says when to wait",
    );
  }
  const domainOk = config.allowDomainListConfinement;
  if (domainOk !== undefined && typeof domainOk !== "boolean") {
    throw new Error("daytona provider option allowDomainListConfinement must be true or false");
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
    // Off unless the operator says so: a domain list rests on Daytona's filter reading the TLS
    // server name, which the strict address allow list does not.
    ...(domainOk === true ? { allowDomainListConfinement: true } : {}),
    ...(preflight !== undefined ? { ownerCiPreflight: preflight } : {}),
    ...(ownerLabels !== undefined && labelWaitAt !== undefined
      ? { ownerCiLabels: ownerLabels, ownerCiLabelWaitAt: labelWaitAt }
      : {}),
    clampTtl: true,
    ...(ttl !== undefined ? { maxTtlSeconds: ttl } : {}),
  });
}
