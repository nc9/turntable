import { expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import { createPollingRealtime } from "../src/api/polling-realtime";
import type { RealtimeMessage } from "../src/api/realtime";
import { LogParser } from "../src/log/parser";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("polling turns snapshots into change events once, and again only when something changes", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 20, seed: "poll1" });
  const rt = createPollingRealtime(fx.api, { intervalMs: 30 });
  try {
    const project = fx.world.projects[0]!;
    const seen: RealtimeMessage[] = [];
    const off = rt.subscribe({ kind: "project", projectId: project.id }, {}, (m) => seen.push(m));
    await wait(150);
    const firstWave = seen.filter((m) => m.type === "change");
    expect(firstWave.length).toBeGreaterThan(0);
    const ids = firstWave.map((m) => (m.type === "change" ? m.value.id : ""));
    // every row is announced at first sight; a quiet row is not repeated on later polls
    const counts = new Map<string, number>();
    for (const m of seen)
      if (m.type === "change") counts.set(m.value.id, (counts.get(m.value.id) ?? 0) + 1);
    const finished = [...fx.world.runs.values()].find(
      (r) => r.projectId === project.id && r.finishedAt !== null,
    )!;
    expect(counts.get(finished.id)).toBe(1);
    expect(ids).toContain(finished.id);
    off();
    const n = seen.length;
    await wait(100);
    expect(seen.length).toBe(n); // unsubscribed: nothing more
    expect(rt.status()).toBe("polling");
  } finally {
    fx.stop();
  }
});

test("a log tail is polled from an offset, in order, and ends with eof", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "poll2" });
  const rt = createPollingRealtime(fx.api, { logIntervalMs: 10 });
  try {
    const attempt = [...fx.world.attempts.values()].find(
      (a) => a.finishedAt !== null && a.state === "success",
    )!;
    const detail = await fx.api.getRun(
      [...fx.world.jobs.values()].find((j) => j.id === attempt.jobId)!.runId,
    );
    expect(detail.attempts.length).toBeGreaterThan(0);
    const head = await fx.api.jobLog({ attemptId: attempt.id, offset: 0, limit: 2000 });
    const parser = new LogParser(0);
    parser.push(head.bytes, 0);
    const done = new Promise<void>((resolve) => {
      rt.subscribe(
        { kind: "attempt-log", attemptId: attempt.id },
        { offset: parser.nextOffset },
        (m) => {
          if (m.type !== "log") return;
          if (m.data.length > 0) expect(parser.push(m.data, m.offset)).toBe("ok");
          if (m.eof) resolve();
        },
      );
    });
    await done;
    const full = await fx.api.jobLog({ attemptId: attempt.id, offset: 0, limit: 1 << 30 });
    expect(parser.nextOffset).toBe(full.bytes.length);
  } finally {
    fx.stop();
  }
});

test("errors show as reconnecting, an auth failure as offline, and polling resumes", async () => {
  let mode: "ok" | "fail" | "auth" = "fail";
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "poll3" });
  const api = {
    ...fx.api,
    listRuns: async (f: Parameters<typeof fx.api.listRuns>[0]) => {
      if (mode === "fail") throw new Error("network down");
      if (mode === "auth") throw Object.assign(new Error("no"), { status: 401 });
      return fx.api.listRuns(f);
    },
  };
  const rt = createPollingRealtime(api, { intervalMs: 15 });
  try {
    const off = rt.subscribe(
      { kind: "project", projectId: fx.world.projects[0]!.id },
      {},
      () => {},
    );
    await wait(60);
    expect(rt.status()).toBe("reconnecting");
    mode = "auth";
    await wait(60);
    expect(rt.status()).toBe("offline");
    mode = "ok";
    await wait(60);
    expect(rt.status()).toBe("polling");
    off();
  } finally {
    fx.stop();
  }
});
