import { describe, expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import { createHttpApi } from "../src/api/http-adapter";
import type { WireArtifacts, WireConsumption } from "../src/api/wire";
import {
  belowRun,
  CLASS_ORDER,
  decideConsumption,
  formatSize,
  releaseUsable,
  shortDigest,
} from "../src/lib/artifact";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("class rule (mirrors the server's)", () => {
  test("same or higher is allowed, lower needs a request and is quarantined, release takes only release", () => {
    for (const consumer of CLASS_ORDER) {
      for (const producer of CLASS_ORDER) {
        const ci = CLASS_ORDER.indexOf(consumer);
        const pi = CLASS_ORDER.indexOf(producer);
        const implicit = decideConsumption({ consumer, producer, explicit: false }).decision;
        const explicit = decideConsumption({ consumer, producer, explicit: true }).decision;
        if (pi >= ci) expect([implicit, explicit]).toEqual(["allow", "allow"]);
        else if (consumer === "release") expect([implicit, explicit]).toEqual(["deny", "deny"]);
        else expect([implicit, explicit]).toEqual(["deny", "quarantine"]);
      }
    }
    expect(
      decideConsumption({ consumer: "release", producer: "weird", explicit: true }).decision,
    ).toBe("deny");
  });

  test("labels: below the run's class is quarantined, and only release artifacts feed release builds", () => {
    expect(belowRun("untrusted_pr", "release")).toBe(true);
    expect(belowRun("release", "release")).toBe(false);
    expect(belowRun("protected", null)).toBe(false);
    expect(releaseUsable("release")).toBe(true);
    for (const c of ["protected", "trusted_pr", "untrusted_pr", "x"])
      expect(releaseUsable(c)).toBe(false);
    expect(shortDigest("a".repeat(64))).toBe(`${"a".repeat(12)}…${"a".repeat(6)}`);
    expect(formatSize(18_400_000)).toBe("18.4 MB");
    expect(formatSize(52)).toBe("52 B");
  });
});

describe("fixture backend", () => {
  test("a finished run has artifacts with provenance, a lower-class one is flagged, and check decides", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "art1" });
    try {
      const run = [...fx.world.runs.values()].find(
        (r) =>
          r.status === "success" && (r.trustClass === "protected" || r.trustClass === "release"),
      );
      expect(run).toBeDefined();
      const rows = await fx.api.getArtifacts({ runId: run!.id, project: "x" });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.find((a) => a.name === "build.tar.gz")).toMatchObject({
        digestSource: "computed",
        trustClass: run!.trustClass,
        runSha: run!.sha,
      });
      const low = rows.find((a) => a.trustClass === "untrusted_pr")!;
      expect(belowRun(low.trustClass, run!.trustClass)).toBe(true);
      // The same run as consumer: its own artifacts are allowed, the lower one is denied unless named.
      const src = { runId: run!.id, name: low.name };
      const [implicit] = await fx.api.checkArtifactConsumption({
        project: "x",
        consumerRunId: run!.id,
        sources: [src],
      });
      expect(implicit!.decision).toBe("deny");
      const [asked] = await fx.api.checkArtifactConsumption({
        project: "x",
        consumerRunId: run!.id,
        sources: [src],
        quarantine: [src],
      });
      expect(asked!.decision).toBe(run!.trustClass === "release" ? "deny" : "quarantine");
      const [own] = await fx.api.checkArtifactConsumption({
        project: "x",
        consumerRunId: run!.id,
        sources: [{ runId: run!.id, name: "build.tar.gz" }],
      });
      expect(own!.decision).toBe("allow");
      const [missing] = await fx.api.checkArtifactConsumption({
        project: "x",
        consumerRunId: run!.id,
        sources: [{ runId: run!.id, name: "nope" }],
      });
      expect(missing).toMatchObject({ decision: "deny", reason: "no such recorded artifact" });
    } finally {
      fx.stop();
    }
  });
});

describe("http adapter", () => {
  test("maps provenance fields and sends the consumption request with the project", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const wireArts: WireArtifacts = {
      artifacts: [
        {
          name: "bin",
          size: 10,
          sha256: "b".repeat(64),
          digest_source: "computed",
          trust_class: "release",
          run_sha: "c".repeat(40),
          attempt_id: "att1",
          created_at: "2026-11-22T10:00:00.000Z",
        },
      ],
    };
    const wireChk: WireConsumption = {
      results: [
        {
          run_id: "r1",
          name: "bin",
          decision: "deny",
          reason: "nope",
          trust_class: "untrusted_pr",
          sha256: null,
        },
      ],
    };
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        calls.push({ url, init });
        return json(url.pathname.endsWith("check-consumption") ? wireChk : wireArts);
      }) as unknown as typeof fetch,
    });
    const rows = await api.getArtifacts({ runId: "r 1", project: "web" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/runs/r%201/artifacts");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ org: "acme", project: "web" });
    expect(rows[0]).toMatchObject({
      digestSource: "computed",
      trustClass: "release",
      runSha: "c".repeat(40),
      attemptId: "att1",
    });
    const res = await api.checkArtifactConsumption({
      project: "web",
      consumerRunId: "r9",
      sources: [{ runId: "r1", name: "bin" }],
      quarantine: [{ runId: "r1", name: "bin" }],
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      org: "acme",
      project: "web",
      consumer_run_id: "r9",
      sources: [{ run_id: "r1", name: "bin" }],
      quarantine: [{ run_id: "r1", name: "bin" }],
    });
    expect(res[0]).toMatchObject({ decision: "deny", trustClass: "untrusted_pr", sha256: null });
  });
});
