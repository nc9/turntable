// What the control plane checks about a provider before it uses it (#41). A provider runs the
// job's untrusted code, so it is a trust boundary in both directions: it must not claim more than
// it has verified, and an unknown one must not be loaded at all.
//
// Built-in providers (docker, daytona) are code in this binary, pinned by the release. Anything
// else is an external plugin: refused unless the operator named it AND pinned its file by sha256,
// and refused outright in hosted mode. Today there is no external loader, so a pinned plugin is
// verified and then refused with a clear message; the gate is in place for when there is one, and
// docs/providers.mdx states what such a process may see.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ISOLATION_ORDER, type IsolationClass, type ProviderInfo } from "@turntable/provider-sdk";

/** What a built-in may claim at most. A declaration above the ceiling is a bug or a lie. */
export type BuiltinCeiling = {
  /** Strongest isolation class it may declare. */
  isolation: IsolationClass;
  /** Egress policies it may declare. */
  egress: readonly string[];
};

export const BUILTIN_CEILINGS: Readonly<Record<string, BuiltinCeiling>> = {
  // Containers; runsc (gVisor) is the strongest a Docker host can be.
  docker: { isolation: "gvisor", egress: ["none", "open", "deny-all-except-proxy"] },
  // Containers on a shared host, over an API. `allowlist` is not verified; the proxy-confined
  // policies are (the strict one needs the endpoint's addresses, the domain-filtered one is an
  // operator opt-in).
  daytona: {
    isolation: "container",
    egress: ["none", "open", "deny-all-except-proxy", "proxy-domain-filtered"],
  },
};

export class ProviderTrustError extends Error {}

const rank = (c: string): number => ISOLATION_ORDER.indexOf(c as IsolationClass);

/**
 * Checks a provider's declaration at registration. The scheduler relies on these facts, so a
 * provider that does not declare them, or declares more than its ceiling, is refused:
 * - it is the provider asked for (name matches);
 * - exec is detached with offset logs (the contract's rule zero) and labels, list-by-label and TTL
 *   exist (cleanup and the cap depend on them);
 * - egress `none` is enforceable (the default for untrusted code) and nothing beyond the ceiling is
 *   claimed; the isolation class is real and not above the ceiling.
 */
export function checkProviderInfo(
  name: string,
  info: ProviderInfo,
  ceiling: BuiltinCeiling | undefined,
): void {
  const fail = (why: string): never => {
    throw new ProviderTrustError(`provider ${name} refused: ${why}`);
  };
  if (info.name !== name) fail(`it declares itself as ${JSON.stringify(info.name)}`);
  if (rank(info.isolation) < 0) fail(`unknown isolation class ${JSON.stringify(info.isolation)}`);
  if (!info.exec?.detached || !info.exec.logsByOffset)
    fail("exec must be detached with offset-based logs");
  if (!info.labels || !info.listByLabel || !info.ttl)
    fail("labels, list by label and a TTL are required (cleanup and caps depend on them)");
  const egress = info.network?.egressPolicy ?? [];
  if (!egress.includes("none")) fail("it cannot enforce egress `none`");
  if (!ceiling) return fail("no ceiling is defined for it");
  if (rank(info.isolation) > rank(ceiling.isolation))
    fail(`it declares isolation ${info.isolation}, above its ceiling ${ceiling.isolation}`);
  const extra = egress.filter((e) => !ceiling.egress.includes(e));
  if (extra.length > 0) fail(`it declares egress policies beyond its ceiling: ${extra.join(", ")}`);
}

export type PluginPin = { name: string; path: string; sha256: string };

/** Parses `TURNTABLE_PROVIDER_PLUGINS`: a JSON array of `{name, path, sha256}`. */
export function parsePluginPins(text: string | undefined): PluginPin[] {
  if (!text?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProviderTrustError("TURNTABLE_PROVIDER_PLUGINS is not valid JSON");
  }
  if (!Array.isArray(raw))
    throw new ProviderTrustError("TURNTABLE_PROVIDER_PLUGINS must be an array");
  return raw.map((e, i) => {
    const o = e as Record<string, unknown>;
    if (
      typeof o?.name !== "string" ||
      !/^[a-z][a-z0-9-]{0,40}$/.test(o.name) ||
      typeof o.path !== "string" ||
      typeof o.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(o.sha256)
    )
      throw new ProviderTrustError(
        `TURNTABLE_PROVIDER_PLUGINS[${i}] needs a lower-case name, a path and a 64-hex sha256`,
      );
    return { name: o.name, path: o.path, sha256: o.sha256 };
  });
}

/**
 * Decides whether a non-built-in provider name may be loaded: never in hosted mode, only if the
 * operator pinned it, and only if the file on disk has exactly the pinned digest. Returns the
 * verified path, or throws.
 */
export function verifyExternalPlugin(
  name: string,
  o: { hosted: boolean; pins: readonly PluginPin[]; read?: (path: string) => Uint8Array },
): string {
  if (o.hosted)
    throw new ProviderTrustError(
      `provider ${name} is not built in, and third-party provider plugins are disabled in hosted mode`,
    );
  const pin = o.pins.find((p) => p.name === name);
  if (!pin)
    throw new ProviderTrustError(
      `unknown provider ${name}: an external plugin runs only when it is named and pinned by sha256 in TURNTABLE_PROVIDER_PLUGINS`,
    );
  let bytes: Uint8Array;
  try {
    bytes = (o.read ?? readFileSync)(pin.path);
  } catch {
    throw new ProviderTrustError(`plugin ${name}: cannot read ${pin.path}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== pin.sha256)
    throw new ProviderTrustError(
      `plugin ${name}: the file's sha256 is ${digest}, not the pinned ${pin.sha256}`,
    );
  return pin.path;
}

/** The only variables a plugin process would start with, plus the names the operator lists. */
const PLUGIN_ENV_BASE = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const;

/**
 * The environment for a plugin process: an allowlist, never the parent's. The vault master key,
 * database paths, tokens and every other variable of the server are absent unless the operator
 * names one for this plugin.
 */
export function pluginEnv(
  parent: Readonly<Record<string, string | undefined>>,
  pass: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...PLUGIN_ENV_BASE, ...pass]) {
    const v = parent[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}
