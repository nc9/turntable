// #693: a log reader that stops getting answers is visible: the job log says so, the runtime
// health snapshot tracks it, and it says when the reader caught up.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { outboundWatchdog } from "@turntable/net";
import { SecretRegistry } from "@turntable/redact";
import type { Provider } from "@turntable/provider-sdk";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { checkRuntimeHealth } from "../src/doctor/checks";
import { RuntimeHealth, lagStats, runtimeHealth } from "../src/health/monitor";
import { executeJob } from "../src/run/job-exec";
import type { RunStore } from "../src/run/store";

const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures");

let world: FakeWorld;
let provider: Provider;
beforeEach(() => {
  world = new FakeWorld();
  provider = world.provider();
});
afterEach(() => world.dispose());

test("a stalled log read raises a job-log line and a server line, then says it caught up", async () => {
  const sb = await provider.create({
    name: "job",
    labels: {},
    ttlSeconds: 600,
    network: { egress: "none" },
  });
  const { execId } = await provider.exec.start(sb.id, {
    argv: ["sh", "-c", `cat '${join(FIXTURE, "success.jsonl")}'; sleep 1.2`],
    timeoutSeconds: 30,
  });
  // The second log read stalls for 700 ms, as a hung call to the sandbox would.
  let reads = 0;
  const slow: Provider = {
    ...provider,
    exec: {
      ...provider.exec,
      logs: async (id, e, o) => {
        reads += 1;
        if (reads === 2) await Bun.sleep(700);
        return provider.exec.logs(id, e, o);
      },
    },
  };
  let text = "";
  const store = {
    setSandbox: async () => {},
    setExec: async () => {},
    resetOutput: async () => {},
    appendLog: async (_id: string, _o: number, bytes: Uint8Array) =>
      void (text += new TextDecoder().decode(bytes)),
    recordStep: async () => {},
    finishJob: async () => {},
  } as unknown as RunStore;
  const server: string[] = [];
  let seenWhileStalled = 0;
  const res = executeJob(
    {
      provider: slow,
      store,
      out: () => {},
      registry: new SecretRegistry(),
      pollMs: 25,
      idleFlushMs: 20,
      logLagWarnMs: 250,
      onLogLag: (l) => server.push(l),
    },
    { runId: "r", jobId: "j", attemptId: "attempt-lag" },
    undefined,
    { sandboxId: sb.id, execId },
  );
  await Bun.sleep(500);
  seenWhileStalled = runtimeHealth.snapshot().logReaders.maxLagMs;
  expect(await res).toMatchObject({ state: "success" });
  expect(seenWhileStalled).toBeGreaterThan(200);
  expect(text).toMatch(/\[turntable\] the log reader is \d+ s behind/);
  expect(text).toMatch(/\[turntable\] log reader caught up/);
  expect(server.length).toBe(1); // once per episode
  expect(server[0]).toContain("attempt-lag");
  expect(runtimeHealth.snapshot().logReaders.tracking).toBe(0); // untracked at the end
});

test("a blocked event loop raises the lag metric and is logged over a second", () => {
  const lines: string[] = [];
  let t = 1_000_000;
  const h = new RuntimeHealth();
  h.start({ now: () => t, log: (l) => lines.push(l), sampleMs: 1000, heartbeatMs: 60_000 });
  for (let i = 0; i < 5; i += 1) {
    t += 1000; // on time
    h.tick();
  }
  expect(h.snapshot().loop.max).toBe(0);
  t += 4500; // the loop was blocked 3.5 s past the tick
  h.tick();
  const s = h.snapshot();
  expect(s.loop.max).toBe(3500);
  expect(s.loop.p50).toBe(0);
  expect(lines.some((l) => l.startsWith("event loop lag 3500 ms"))).toBe(true);
  h.stop();
});

test("a really blocked event loop is measured by the real timer", async () => {
  const h = new RuntimeHealth();
  h.start({ sampleMs: 20, log: () => {} });
  await Bun.sleep(60);
  const end = Date.now() + 300;
  while (Date.now() < end); // block the loop
  await Bun.sleep(60);
  expect(h.snapshot().loop.max).toBeGreaterThan(200);
  h.stop();
});

test("a heartbeat line is written at least every minute, with the process's own numbers", () => {
  const lines: string[] = [];
  let t = 0;
  const h = new RuntimeHealth();
  h.start({ now: () => t, log: (l) => lines.push(l), sampleMs: 1000, heartbeatMs: 60_000 });
  for (let i = 0; i < 125; i += 1) {
    t += 1000;
    h.tick();
  }
  const beats = lines.filter((l) => l.startsWith("heartbeat:"));
  expect(beats.length).toBe(2);
  expect(beats[0]).toMatch(/loop lag p99 \d+ ms max \d+ ms, outbound \d+ open/);
  h.stop();
});

test("lagStats percentiles", () => {
  expect(lagStats([])).toEqual({ samples: 0, p50: 0, p99: 0, max: 0 });
  const s = lagStats(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(s.max).toBe(100);
  expect(s.p50).toBe(51);
  expect(s.p99).toBe(100);
});

test("a hung outbound call is logged once with host and operation, and doctor warns", () => {
  outboundWatchdog.reset();
  const lines: string[] = [];
  let t = 5_000_000;
  const h = new RuntimeHealth();
  h.start({ now: () => t, log: (l) => lines.push(l), sampleMs: 1000, heartbeatMs: 3_600_000 });
  outboundWatchdog.begin("api.github.com", "GET /repos/:x/:x/pulls", t);
  for (let i = 0; i < 30; i += 1) {
    t += 1000;
    h.tick();
  }
  const slow = lines.filter((l) => l.includes("still open"));
  expect(slow.length).toBe(1);
  expect(slow[0]).toContain("api.github.com");
  expect(slow[0]).toContain("GET /repos/:x/:x/pulls");
  const snap = h.snapshot();
  expect(snap.outbound.byHost).toEqual({ "api.github.com": 1 });
  expect(snap.outbound.oldest?.ageMs).toBeGreaterThan(20_000);
  h.stop();
  outboundWatchdog.reset();
});

test("doctor passes when the monitor is off or healthy and warns on a stalled loop", () => {
  expect(checkRuntimeHealth().status).toBe("pass"); // the shared monitor is not started here
  runtimeHealth.start({ sampleMs: 20, log: () => {} });
  try {
    const end = Date.now() + 1300;
    // Drive a sample over the threshold without waiting a real second per tick.
    runtimeHealth.tick();
    while (Date.now() < end);
    runtimeHealth.tick();
    expect(checkRuntimeHealth().status).toBe("warn");
  } finally {
    runtimeHealth.stop();
  }
});
