// Probe bounds and the max degraded time (#698): the probe can never hang a caller or hold claims for good.
import { describe, expect, test } from "bun:test";
import { checkEgress } from "../src/doctor/checks";
import { NetworkHealth, egressProbe, networkProbeConfig } from "../src/network";

const never = () => new Promise<never>(() => {});

describe("every probe step is bounded", () => {
  test("a lookup that never settles fails that target", async () => {
    const probe = egressProbe({
      targets: [{ label: "forge", url: "https://example.test/rate_limit" }],
      lookup: never,
      timeoutMs: 20,
    });
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.targets[0]?.error).toBe("TIMEOUT");
  });

  test("a fetch that never settles fails that target", async () => {
    const probe = egressProbe({
      targets: [{ label: "forge", url: "https://example.test/rate_limit" }],
      lookup: async () => ({}),
      fetch: never as never,
      timeoutMs: 20,
    });
    expect((await probe()).ok).toBe(false);
  });

  test("a probe that never settles counts as failed, frees the slot, and probeNow resolves", async () => {
    let t = 0;
    const net = new NetworkHealth({
      probe: never,
      probeDeadlineMs: 20,
      now: () => (t += 15_000),
    });
    await net.probeNow();
    expect(net.suspect).toBe(true);
    await net.probeNow(); // the slot was freed: this is a new probe, not the old one
    expect(net.degraded).toBe(true);
    expect(net.snapshot().last_probe?.targets[0]?.error).toBe("timeout");
  });
});

describe("max degraded duration", () => {
  const bad = { ok: false, targets: [{ target: "forge", ok: false, error: "ENOTFOUND" }] };
  test("claims resume after the maximum, with a warning hook and a doctor failure", async () => {
    const clock = { t: 1_000_000 };
    let gaveUp = 0;
    const net = new NetworkHealth({
      now: () => clock.t,
      maxDegradedMs: 15 * 60_000,
      onGiveUp: () => gaveUp++,
    });
    net.record(bad);
    net.record(bad);
    expect(net.degraded).toBe(true);
    expect(checkEgress(net).status).toBe("warn");
    clock.t += 15 * 60_000 - 1;
    expect(net.degraded).toBe(true);
    clock.t += 1;
    expect(net.degraded).toBe(false);
    expect(net.degraded).toBe(false);
    expect(gaveUp).toBe(1);
    expect(net.snapshot().gave_up).toBe(true);
    expect(checkEgress(net).status).toBe("fail");
    // The probe still failing does not hold claims again.
    net.record(bad);
    expect(net.degraded).toBe(false);
    // Two successes clear it.
    const ok = { ok: true, targets: [{ target: "forge", ok: true }] };
    net.record(ok);
    net.record(ok);
    expect(net.snapshot().gave_up).toBe(false);
    expect(checkEgress(net).status).toBe("pass");
  });

  test("a waiter for recovery is released at the maximum", async () => {
    const clock = { t: 0 };
    const net = new NetworkHealth({ now: () => clock.t, maxDegradedMs: 50 });
    net.record(bad);
    net.record(bad);
    const start = Date.now();
    clock.t = 40;
    const w = net.waitHealthy(60_000);
    clock.t = 100;
    await w;
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("settings", () => {
  test("auto is on for daytona only; the forge target follows the API base", () => {
    expect(networkProbeConfig({}, "daytona", "https://api.github.com").enabled).toBe(true);
    expect(networkProbeConfig({}, "docker", "https://api.github.com").enabled).toBe(false);
    expect(
      networkProbeConfig({ TURNTABLE_NETWORK_PROBE: "on" }, "docker", "https://x.test/api/v3/")
        .forgeUrl,
    ).toBe("https://x.test/api/v3/rate_limit");
    expect(
      networkProbeConfig({ TURNTABLE_NETWORK_PROBE: "off" }, "daytona", "https://a.test").enabled,
    ).toBe(false);
  });
  test("bad values throw", () => {
    expect(() =>
      networkProbeConfig({ TURNTABLE_NETWORK_PROBE: "x" }, "docker", "https://a.test"),
    ).toThrow();
    expect(() =>
      networkProbeConfig(
        { TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS: "5" },
        "docker",
        "https://a.test",
      ),
    ).toThrow();
    expect(
      networkProbeConfig(
        { TURNTABLE_NETWORK_MAX_DEGRADED_SECONDS: "120" },
        "docker",
        "https://a.test",
      ).maxDegradedMs,
    ).toBe(120_000);
  });
});
