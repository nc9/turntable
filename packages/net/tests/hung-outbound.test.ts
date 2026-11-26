// #693: a hung outbound call is bounded, visible to the watchdog and never outlives its deadline.
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import {
  OutboundWatchdog,
  RequestTimeoutError,
  coarsePath,
  createHttpClient,
  outboundWatchdog,
} from "../src/index";

const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
  outboundWatchdog.reset();
});

/** A server that accepts the connection and never answers. */
async function blackhole(): Promise<number> {
  const srv = net.createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return (srv.address() as net.AddressInfo).port;
}

describe("hung outbound calls", () => {
  test("a server that never answers times out, and the watchdog saw it open", async () => {
    const port = await blackhole();
    const c = createHttpClient({ allowHosts: ["127.0.0.1"] });
    const t0 = Date.now();
    const p = c.fetch(`http://127.0.0.1:${port}/repos/o/r/pulls?token=abc`, { timeoutMs: 300 });
    const settled = p.then(
      () => "ok",
      (e: unknown) => e,
    );
    await Bun.sleep(100);
    const snap = outboundWatchdog.snapshot();
    expect(snap.inFlight).toBe(1);
    expect(snap.byHost["127.0.0.1"]).toBe(1);
    expect(snap.oldest?.op).toBe("GET /repos/:x/:x/pulls");
    expect(JSON.stringify(snap)).not.toContain("token");
    expect(snap.oldest?.ageMs ?? 0).toBeGreaterThanOrEqual(90);
    const err = await settled;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000);
    const after = outboundWatchdog.snapshot();
    expect(after.inFlight).toBe(0);
    expect(after.timeouts["127.0.0.1"]).toBe(1);
  });

  test("a resolver that never answers is cut off by its own limit", async () => {
    const c = createHttpClient({
      resolve: () => new Promise<string[]>(() => {}),
      resolveMs: 100,
      timeoutMs: 5000,
    });
    const t0 = Date.now();
    const err = await c.fetch("https://hung.example.test/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(outboundWatchdog.snapshot().inFlight).toBe(0);
  });

  test("a resolver that never answers is cut off by the call's deadline when that is sooner", async () => {
    const c = createHttpClient({
      resolve: () => new Promise<string[]>(() => {}),
      resolveMs: 60_000,
    });
    const err = await c.fetch("https://hung.example.test/x", { timeoutMs: 150 }).catch((e) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });

  test("a tunnel to a name that never resolves gives up", async () => {
    const c = createHttpClient({ resolve: () => new Promise<string[]>(() => {}), resolveMs: 100 });
    const err = await c.tunnel("hung.example.test", 443).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });

  test("a caller's abort ends a hung call too", async () => {
    const port = await blackhole();
    const c = createHttpClient({ allowHosts: ["127.0.0.1"] });
    const ac = new AbortController();
    const p = c.fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal, timeoutMs: 10_000 });
    setTimeout(() => ac.abort(new Error("stop")), 50);
    await expect(p).rejects.toThrow("stop");
    expect(outboundWatchdog.snapshot().inFlight).toBe(0);
  });
});

describe("watchdog", () => {
  test("counts per host, reports the oldest and flags a slow call once", () => {
    const w = new OutboundWatchdog();
    const a = w.begin("api.github.com", "GET /repos", 1000);
    w.begin("api.github.com", "GET /user", 5000);
    w.begin("app.daytona.io", "POST /x", 6000);
    const s = w.snapshot(11_000);
    expect(s.inFlight).toBe(3);
    expect(s.byHost).toEqual({ "api.github.com": 2, "app.daytona.io": 1 });
    expect(s.oldest).toEqual({ host: "api.github.com", op: "GET /repos", ageMs: 10_000 });
    const slow = w.takeSlow(8000, 11_000);
    expect(slow.map((c) => c.op)).toEqual(["GET /repos"]);
    expect(w.takeSlow(8000, 12_000)).toEqual([]); // once
    a();
    expect(w.snapshot(12_000).inFlight).toBe(2);
  });

  test("coarsePath drops anything identifier-like and the query", () => {
    expect(coarsePath("/repos/acme/secret-repo/git/refs")).toBe("/repos/:x/:x/git/refs");
    expect(coarsePath("/repos/a/b/git/refs/x/y")).toBe("/repos/:x/:x/git/refs/...");
  });
});
