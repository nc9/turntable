import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_KEY, startMock } from "@longshore/provider-daytona/testing";
import { egressForRun } from "../src/scheduler/egress";
import { createProvider } from "../src/scheduler/providers";

let mock: ReturnType<typeof startMock>;
let dir: string;
beforeEach(() => {
  mock = startMock();
  // The mock Daytona listens on loopback: allow exactly that host for the outbound client.
  process.env.LONGSHORE_NET_ALLOW_HOSTS = "127.0.0.1";
  dir = mkdtempSync(join(tmpdir(), "ls-prov-"));
});
afterEach(async () => {
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LS_TEST_DAYTONA_KEY;
  delete process.env.LONGSHORE_NET_ALLOW_HOSTS;
});

test("daytona is selectable and its options are validated strictly", () => {
  expect(createProvider("daytona", { apiKeyEnv: "X" }).info.name).toBe("daytona");
  expect(() => createProvider("daytona", { nope: 1 })).toThrow(/unknown daytona provider option/);
  expect(() => createProvider("daytona", { maxLive: 4 })).toThrow(
    /maxLive must be an integer from 1 to 3/,
  );
  expect(() => createProvider("daytona", { maxLive: 0 })).toThrow();
  expect(() => createProvider("daytona", { maxLive: "2" })).toThrow();
  expect(() => createProvider("daytona", { ttlSeconds: 3600 })).toThrow(/ttlSeconds/);
  expect(() => createProvider("daytona", { ownerCiPreflight: false })).toThrow(
    /cannot be turned off/,
  );
  expect(() => createProvider("daytona", { apiKeyFile: "/k", apiKeyEnv: "K" })).toThrow(
    /only one of/,
  );
  expect(() => createProvider("daytona", { baseUrl: "" })).toThrow(/non-empty string/);
  // the account-rule settings are not options at all
  expect(() => createProvider("daytona", { labelPrefix: "x" })).toThrow(
    /unknown daytona provider option/,
  );
  expect(() => createProvider("daytona", { ownerCiPreflight: true, maxLive: 3 })).not.toThrow();
});

test("a daytona provider built from config talks to the API with the key from a file, and applies the account rules", async () => {
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${MOCK_KEY}\n`);
  const p = createProvider("daytona", {
    baseUrl: mock.url,
    apiKeyFile: keyFile,
    maxLive: 1,
    snapshot: "base-image",
  });
  await p.healthcheck();
  // the scheduler's own spec: an image, and a TTL past 30 minutes
  const h = await p.create({
    name: "tt-run-ABC123",
    labels: { "longshore.run": "r1", "longshore.job": "j1" },
    image: "ghcr.io/example/runner:1",
    ttlSeconds: 3600 + 900,
    network: { egress: "none" },
  });
  const body = mock.requests.find((r) => r.method === "POST" && r.path === "/api/sandbox")!
    .body as Record<string, unknown>;
  expect(body).toMatchObject({
    name: "longshore-dev-tt-run-abc123",
    snapshot: "base-image",
    networkBlockAll: true,
    ttlMinutes: 30,
    autoStopInterval: 30,
    autoDeleteInterval: 0,
  });
  expect(body.labels).toMatchObject({ "longshore-dev": "1", "longshore.run": "r1" });
  expect(body).not.toHaveProperty("buildInfo");
  expect(body).not.toHaveProperty("env");
  expect(await p.count({})).toBe(1);
  await p.destroy(h.id);
  expect(await p.count({})).toBe(0);
});

test("the key comes from the named env var, and a wrong key fails the startup healthcheck without echoing it", async () => {
  process.env.LS_TEST_DAYTONA_KEY = "not-the-right-key";
  const bad = createProvider("daytona", { baseUrl: mock.url, apiKeyEnv: "LS_TEST_DAYTONA_KEY" });
  const err = (await bad.healthcheck().catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("rejected the API key");
  expect(err.message).not.toContain("not-the-right-key");
  process.env.LS_TEST_DAYTONA_KEY = MOCK_KEY;
  await createProvider("daytona", {
    baseUrl: mock.url,
    apiKeyEnv: "LS_TEST_DAYTONA_KEY",
  }).healthcheck();
});

test("egress is none unless the run's plan, or an explicit runner option, says open", () => {
  expect(egressForRun(null)).toBe("none");
  expect(egressForRun(undefined)).toBe("none");
  expect(egressForRun("{}")).toBe("none");
  expect(egressForRun(JSON.stringify({ egress: "none" }))).toBe("none");
  expect(egressForRun(JSON.stringify({ egress: "open" }))).toBe("open");
  for (const odd of [
    '{"egress":"OPEN"}',
    '{"egress":true}',
    '{"egress":"deny-all-except-proxy"}',
    "not json",
    "null",
    "[]",
    '"open"',
    '{"egress":["open"]}',
  ]) {
    expect(egressForRun(odd)).toBe("none");
  }
  expect(egressForRun(null, "open")).toBe("open");
  expect(egressForRun(JSON.stringify({ egress: "none" }), "open")).toBe("open"); // an explicit local opt-in
  expect(egressForRun(JSON.stringify({ egress: "open" }), "none")).toBe("open");
});

test("isolation is declared from what the provider really is: docker is a container, gvisor only with runsc, daytona a container", () => {
  expect(createProvider("docker", {}).info.isolation).toBe("container");
  expect(createProvider("docker", { runtime: "runc" }).info.isolation).toBe("container");
  expect(createProvider("docker", { runtime: "runsc" }).info.isolation).toBe("gvisor");
  expect(createProvider("daytona", {}).info.isolation).toBe("container");
});
