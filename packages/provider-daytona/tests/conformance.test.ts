import { appendFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { runConformance } from "@turntable/provider-conformance";
import { DaytonaApi, type DaytonaSandbox } from "../src/api";
import { DaytonaProvider, type UsageRecord, withSandbox } from "../src/index";

// LIVE: runs against a real Daytona account, so it only runs when TT_DAYTONA_CONFORMANCE=1. Use
// scripts/live-check.ts, which reads the key without printing it, runs this file once, then
// reports sandbox-minutes and confirms nothing of ours is left. The account rules in policy.ts
// apply (labelled and named sandboxes, at most 2 live, 30 minute backstops, deleted after each
// test, no snapshots).
const live = process.env.TT_DAYTONA_CONFORMANCE === "1";

if (!live) {
  test.skip("daytona live conformance (set TT_DAYTONA_CONFORMANCE=1; see scripts/live-check.ts)", () => {});
} else {
  const keyEnv = process.env.TT_DAYTONA_KEY_ENV ?? "DAYTONA_API_KEY";
  const usageLog = process.env.TT_DAYTONA_USAGE_LOG;
  const runId = `conf-${crypto.randomUUID().slice(0, 8)}`;
  const baseUrl = process.env.TT_DAYTONA_BASE_URL;
  const make = () =>
    new DaytonaProvider({
      apiKey: { env: keyEnv },
      runId,
      maxLive: 2,
      ...(baseUrl ? { baseUrl } : {}),
      ...(usageLog
        ? { onUsage: (r: UsageRecord) => appendFileSync(usageLog, `${JSON.stringify(r)}\n`) }
        : {}),
    });

  runConformance(make, {
    name: "daytona (live)",
    maxConcurrentSandboxes: 2,
    silentGapSeconds: 3,
    // The default image may have curl or wget; either must fail under egress none (125 if neither
    // exists, which the live "verified capabilities" test below would then catch).
    egressProbe: [
      "sh",
      "-c",
      "if command -v curl >/dev/null; then curl -sS -m 5 -o /dev/null http://1.1.1.1; elif command -v wget >/dev/null; then wget -T 3 -q -O /dev/null http://1.1.1.1; else exit 125; fi",
    ],
    pollIntervalMs: 500,
    testTimeoutMs: 300_000,
  });

  // What the provider declares about itself, checked against the real service.
  describe("daytona: declared capabilities, verified", () => {
    const api = new DaytonaApi({ apiKey: { env: keyEnv }, ...(baseUrl ? { baseUrl } : {}) });
    const sh = async (p: DaytonaProvider, id: string, script: string, timeoutSeconds = 30) => {
      const { execId } = await p.exec.start(id, { argv: ["sh", "-c", script], timeoutSeconds });
      for (;;) {
        const s = await p.exec.status(id, execId);
        if (s.state !== "running") {
          const logs = await p.exec.logs(id, execId, { fromOffset: 0, maxBytes: 1 << 20 });
          return { status: s, out: new TextDecoder().decode(logs.bytes) };
        }
        await Bun.sleep(500);
      }
    };

    test("egress none blocks, egress open allows, and the platform facts we document hold", async () => {
      const p = make();
      const spec = (egress: "none" | "open") => ({
        name: `verify-${egress}-${runId}`,
        labels: { "turntable-run": runId },
        ttlSeconds: 600,
        network: { egress },
      });
      // egress none: outbound connections fail
      await withSandbox(p, spec("none"), async (id) => {
        const probe = await sh(p, id, "curl -sS -m 6 -o /dev/null https://example.com; echo rc=$?");
        expect(probe.out).not.toContain("rc=0");
        const sb = await api.json<DaytonaSandbox>("GET", `/sandbox/${id}`);
        expect(sb.networkBlockAll).toBe(true);
        console.log(
          `verified: egress none blocks (probe: ${probe.out.trim().split("\n").pop()}); class=${sb.sandboxClass}`,
        );
      });
      // egress open: the same probe succeeds
      await withSandbox(p, spec("open"), async (id) => {
        const probe = await sh(
          p,
          id,
          "curl -sS -m 10 -o /dev/null https://example.com; echo rc=$?",
        );
        expect(probe.out).toContain("rc=0");
        const info = await sh(
          p,
          id,
          "uname -sm; nproc; id -un; echo ${TT_CANARY:-unset}; cat /proc/meminfo | head -1",
        );
        console.log(
          `verified: egress open allows; platform: ${info.out.trim().replaceAll("\n", " | ")}`,
        );
        const sb = await api.json<DaytonaSandbox>("GET", `/sandbox/${id}`);
        console.log(
          `sandbox facts: class=${sb.sandboxClass} cpu=${sb.cpu} memGB=${sb.memory} diskGB=${sb.disk}`,
        );
        expect(info.out).toContain("Linux");
      });
    }, 300_000);
  });
}
