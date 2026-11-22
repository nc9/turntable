import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "@longshore/provider-docker";
import type { ProviderInfo } from "@longshore/provider-sdk";
import { createProvider } from "../src/scheduler/providers";
import {
  BUILTIN_CEILINGS,
  checkProviderInfo,
  parsePluginPins,
  pluginEnv,
  ProviderTrustError,
  verifyExternalPlugin,
} from "../src/scheduler/provider-trust";

const base = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  ...new DockerProvider().info,
  ...over,
});
const docker = BUILTIN_CEILINGS.docker;

describe("declared capabilities are checked at registration", () => {
  test("the real built-in declarations pass", () => {
    checkProviderInfo("docker", new DockerProvider().info, docker);
    checkProviderInfo(
      "docker",
      new DockerProvider({ hardening: { runtime: "runsc" } }).info,
      docker,
    );
    expect(createProvider("docker").info.name).toBe("docker");
  });

  test("a provider that claims more than its ceiling, or less than the contract needs, is refused", () => {
    const refuse = (info: ProviderInfo, ceiling = docker, name = "docker") =>
      expect(() => checkProviderInfo(name, info, ceiling)).toThrow(ProviderTrustError);
    // Wrong name, unknown or too-strong isolation.
    refuse(base({ name: "evil" }));
    refuse(base({ isolation: "microvm" }));
    refuse(base({ isolation: "bogus" as never }));
    // Daytona's ceiling is container: gvisor is above it.
    refuse(base({ name: "daytona", isolation: "gvisor" }), BUILTIN_CEILINGS.daytona, "daytona");
    // The proxy-confined policies are within daytona's ceiling; `allowlist` is not.
    checkProviderInfo(
      "daytona",
      base({
        name: "daytona",
        isolation: "container",
        network: {
          ...base().network,
          egressPolicy: ["none", "open", "deny-all-except-proxy", "proxy-domain-filtered"],
        },
      }),
      BUILTIN_CEILINGS.daytona,
    );
    // Egress beyond the ceiling, or no way to enforce `none`.
    refuse(
      base({
        name: "daytona",
        isolation: "container",
        network: { ...base().network, egressPolicy: ["none", "allowlist"] },
      }),
      BUILTIN_CEILINGS.daytona,
      "daytona",
    );
    refuse(base({ network: { ...base().network, egressPolicy: ["open"] } }));
    // Contract rule zero and the cleanup facilities.
    refuse(base({ exec: { ...base().exec, logsByOffset: false as never } }));
    refuse(base({ exec: { ...base().exec, detached: false as never } }));
    refuse(base({ labels: false }));
    refuse(base({ listByLabel: false }));
    refuse(base({ ttl: false }));
    // No ceiling at all is a refusal, not a pass.
    expect(() => checkProviderInfo("docker", base(), undefined)).toThrow(ProviderTrustError);
  });
});

describe("external plugins", () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-plugin-"));
  const file = join(dir, "plugin.js");
  writeFileSync(file, "export default {}");
  const digest = createHash("sha256").update("export default {}").digest("hex");

  test("an unknown provider is refused unless pinned by digest, and never in hosted mode", () => {
    expect(() => createProvider("sneaky", {}, { pins: [] })).toThrow(/pinned by sha256/);
    // Pinned with the right digest: verified, but this build has no loader, and says so.
    expect(() =>
      createProvider("acme", {}, { pins: [{ name: "acme", path: file, sha256: digest }] }),
    ).toThrow(/no external provider loader/);
    // A wrong digest (the file changed) is refused.
    expect(() =>
      createProvider("acme", {}, { pins: [{ name: "acme", path: file, sha256: "0".repeat(64) }] }),
    ).toThrow(/not the pinned/);
    // Hosted mode disables third-party plugins whatever is pinned.
    expect(() =>
      createProvider(
        "acme",
        {},
        { hosted: true, pins: [{ name: "acme", path: file, sha256: digest }] },
      ),
    ).toThrow(/disabled in hosted mode/);
    // A pin for another name does not help, and an unreadable path is refused.
    expect(() =>
      verifyExternalPlugin("other", {
        hosted: false,
        pins: [{ name: "acme", path: file, sha256: digest }],
      }),
    ).toThrow(/pinned by sha256/);
    expect(() =>
      verifyExternalPlugin("acme", {
        hosted: false,
        pins: [{ name: "acme", path: join(dir, "missing"), sha256: digest }],
      }),
    ).toThrow(/cannot read/);
    // The built-ins stay available in hosted mode.
    expect(createProvider("docker", {}, { hosted: true }).info.name).toBe("docker");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the pin list is parsed strictly", () => {
    expect(parsePluginPins(undefined)).toEqual([]);
    expect(
      parsePluginPins(`[{"name":"acme","path":"/p","sha256":"${"a".repeat(64)}"}]`),
    ).toHaveLength(1);
    for (const bad of [
      "not json",
      "{}",
      `[{"name":"Acme","path":"/p","sha256":"${"a".repeat(64)}"}]`,
      `[{"name":"acme","path":"/p","sha256":"short"}]`,
      `[{"name":"acme","sha256":"${"a".repeat(64)}"}]`,
    ])
      expect(() => parsePluginPins(bad), bad).toThrow(ProviderTrustError);
  });

  test("a plugin process would start with an allowlisted environment, nothing of the server's", () => {
    const parent = {
      PATH: "/bin",
      LANG: "C",
      LONGSHORE_MASTER_KEY: "secret-master",
      DATABASE_URL: "postgres://x",
      DAYTONA_API_KEY: "key",
      HOME: "/root",
    };
    expect(pluginEnv(parent)).toEqual({ PATH: "/bin", LANG: "C" });
    // Only a name the operator lists for this plugin is passed on.
    expect(pluginEnv(parent, ["DAYTONA_API_KEY"])).toEqual({
      PATH: "/bin",
      LANG: "C",
      DAYTONA_API_KEY: "key",
    });
    expect(Object.keys(pluginEnv(parent))).not.toContain("LONGSHORE_MASTER_KEY");
  });
});
