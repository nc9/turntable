import { describe, expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import { createHttpApi } from "../src/api/http-adapter";
import type { WireArtifacts, WireConsumption } from "../src/api/wire";
import { formatSize, shortDigest } from "../src/lib/artifact";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("display formatting", () => {
  expect(shortDigest("a".repeat(64))).toBe(`${"a".repeat(12)}…${"a".repeat(6)}`);
  expect(formatSize(18_400_000)).toBe("18.4 MB");
  expect(formatSize(52)).toBe("52 B");
  expect(formatSize(0)).toBe("0 B");
});

describe("fixture backend gives server-shaped answers", () => {
  // The UI never decides who may consume an artifact: it shows these answers. These cases pin the
  // shape the panel reads (decision, reason, trust class) the way the real operation returns it.
  test("provenance, and consumption as a run and as a class", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "art1" });
    try {
      const run = [...fx.world.runs.values()].find(
        (r) =>
          r.status === "success" && (r.trustClass === "protected" || r.trustClass === "release"),
      )!;
      const rows = await fx.api.getArtifacts({ runId: run.id, project: "x" });
      expect(rows.find((a) => a.name === "build.tar.gz")).toMatchObject({
        digestSource: "computed",
        trustClass: run.trustClass,
        runSha: run.sha,
      });
      const low = rows.find((a) => a.trustClass === "untrusted_pr")!;
      const src = { runId: run.id, name: low.name };
      const own = { runId: run.id, name: "build.tar.gz" };
      const ask = (consumer: { runId: string } | { klass: string }, quarantine?: (typeof src)[]) =>
        fx.api.checkArtifactConsumption({
          project: "x",
          consumer,
          sources: [src, own],
          ...(quarantine ? { quarantine } : {}),
        });
      // As a release build: the lower-class artifact is denied with a reason, even when named.
      const asRelease = await ask({ klass: "release" }, [src]);
      expect(asRelease[0]).toMatchObject({
        decision: "deny",
        reason: "a release build consumes nothing below the release class",
        trustClass: "untrusted_pr",
      });
      // As this run: allowed for its own class (when the run is not itself release), a lower one
      // denied until named, then quarantine.
      const asRun = await ask({ runId: run.id });
      expect(asRun[0]!.decision).toBe("deny");
      expect(asRun[0]!.reason).toContain("request it explicitly");
      if (run.trustClass === "protected") {
        expect((await ask({ runId: run.id }, [src]))[0]!.decision).toBe("quarantine");
        expect(asRun[1]!.decision).toBe("allow");
      }
      // An unknown artifact is denied, never an error.
      const [missing] = await fx.api.checkArtifactConsumption({
        project: "x",
        consumer: { klass: "protected" },
        sources: [{ runId: run.id, name: "nope" }],
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
    const sources = [{ runId: "r1", name: "bin" }];
    const byRun = await api.checkArtifactConsumption({
      project: "web",
      consumer: { runId: "r9" },
      sources,
      quarantine: sources,
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      org: "acme",
      project: "web",
      consumer_run_id: "r9",
      sources: [{ run_id: "r1", name: "bin" }],
      quarantine: [{ run_id: "r1", name: "bin" }],
    });
    expect(byRun[0]).toMatchObject({ decision: "deny", trustClass: "untrusted_pr", sha256: null });
    // By class: consumer_class, and no consumer_run_id.
    await api.checkArtifactConsumption({ project: "web", consumer: { klass: "release" }, sources });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      org: "acme",
      project: "web",
      consumer_class: "release",
      sources: [{ run_id: "r1", name: "bin" }],
    });
  });
});
