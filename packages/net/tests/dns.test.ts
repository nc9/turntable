import { expect, test } from "bun:test";
import dgram from "node:dgram";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDnsResolver } from "../src/dns";

async function blackhole(): Promise<{ port: number; close: () => void }> {
  const s = dgram.createSocket("udp4");
  s.on("message", () => {});
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
  return { port: s.address().port, close: () => s.close() };
}

test("event loop keeps ticking (drift < 500 ms) while resolution times out", async () => {
  const bh = await blackhole();
  try {
    const resolve = createDnsResolver({
      servers: [`127.0.0.1:${bh.port}`],
      timeoutMs: 400,
      tries: 2,
      hostsPath: "/nonexistent",
    });
    let last = performance.now();
    let drift = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      drift = Math.max(drift, t - last - 50);
      last = t;
    }, 50);
    const t0 = performance.now();
    await expect(resolve("never.example.test")).rejects.toBeDefined();
    clearInterval(timer);
    expect(performance.now() - t0).toBeGreaterThan(300);
    expect(drift).toBeLessThan(500);
  } finally {
    bh.close();
  }
});

test("localhost and a hosts-only name resolve without DNS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-hosts-"));
  const hosts = join(dir, "hosts");
  writeFileSync(hosts, "10.1.2.3 db.internal alias.internal # c\n::1 v6.internal\n");
  // a server that never answers: any DNS use would time out
  const resolve = createDnsResolver({
    servers: ["127.0.0.1:9"],
    timeoutMs: 200,
    tries: 1,
    hostsPath: hosts,
  });
  expect(await resolve("localhost")).toEqual(["127.0.0.1", "::1"]);
  expect(await resolve("x.localhost")).toEqual(["127.0.0.1", "::1"]);
  expect(await resolve("DB.internal")).toEqual(["10.1.2.3"]);
  expect(await resolve("alias.internal")).toEqual(["10.1.2.3"]);
  expect(await resolve("v6.internal")).toEqual(["::1"]);
});

test("a failed resolution is an error, never a getaddrinfo fallback", async () => {
  const resolve = createDnsResolver({
    servers: ["127.0.0.1:9"],
    timeoutMs: 200,
    tries: 1,
    hostsPath: "/nonexistent",
  });
  await expect(resolve("localhost.example.invalid")).rejects.toBeDefined();
});
