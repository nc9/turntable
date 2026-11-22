import { expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import type { ChangeEvent, LogChunkEvent } from "../src/api/realtime";
import { LogParser } from "../src/log/parser";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("log stream resumes by byte offset with no loss or duplicates and parses to the same lines", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 50, seed: "t1" });
  try {
    // A finished attempt with a log.
    const attempt = [...fx.world.attempts.values()].find(
      (a) => a.finishedAt !== null && a.state === "success",
    )!;
    const full = await fx.api.jobLog({ attemptId: attempt.id, offset: 0, limit: 1 << 30 });
    expect(full.done).toBe(true);

    // Read the first 5000 bytes by offset, then stream the rest from there (a "reconnect").
    const head = await fx.api.jobLog({ attemptId: attempt.id, offset: 0, limit: 5000 });
    const parser = new LogParser(0);
    parser.push(head.bytes, head.offset);
    for (const st of await fx.api.jobSteps({ attemptId: attempt.id })) {
      if (st.logOffset < parser.nextOffset) parser.applyStep(st);
    }
    const chunks: LogChunkEvent[] = [];
    const done = new Promise<void>((resolve) => {
      fx.realtime.subscribe(
        { kind: "attempt-log", attemptId: attempt.id },
        { offset: parser.nextOffset },
        (m) => {
          if (m.type === "step") parser.applyStep(m);
          if (m.type !== "log") return;
          chunks.push(m);
          expect(parser.push(m.data, m.offset)).toBe("ok");
          if (m.eof) resolve();
        },
      );
    });
    await done;
    expect(parser.nextOffset).toBe(full.bytes.length);
    const reference = new LogParser(0);
    reference.push(full.bytes, 0);
    expect(parser.lines.map((l) => l.text)).toEqual(reference.lines.map((l) => l.text));
    // Steps arrive out of band and match what the API reports for the whole attempt.
    const all = await fx.api.jobSteps({ attemptId: attempt.id });
    expect(parser.steps.length).toBe(new Set(all.map((st) => st.index)).size);
    expect(parser.steps.every((st) => st.result !== null)).toBe(true);
    expect(chunks.some((c) => c.data.length > 0 && c.offset === head.bytes.length)).toBe(true);
  } finally {
    fx.stop();
  }
});

test("change events replay from a cursor, then go live, without gaps or duplicates", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 20, seed: "t2" });
  try {
    const project = fx.world.projects[0]!;
    const start = fx.world.cursor();
    await wait(400);
    const seen: ChangeEvent[] = [];
    const off = fx.realtime.subscribe(
      { kind: "project", projectId: project.id },
      { cursor: start },
      (m) => {
        if (m.type === "change") seen.push(m);
      },
    );
    await wait(400);
    off();
    const cursors = seen.map((e) => e.cursor);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors.toSorted()).toEqual(cursors);
    // Everything for this project after `start` was delivered exactly once.
    const expected = fx.world.events.filter(
      (e) =>
        e.cursor > start && e.value.projectId === project.id && e.cursor <= (cursors.at(-1) ?? ""),
    );
    expect(cursors).toEqual(expected.map((e) => e.cursor));
    expect(seen.length).toBeGreaterThan(0);
  } finally {
    fx.stop();
  }
});

test("cancel stops unfinished jobs; rerun requeues failed jobs with a reason", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "t3" });
  try {
    const active = [...fx.world.runs.values()].find(
      (r) => r.status === "running" || r.status === "queued",
    )!;
    await fx.api.cancel({ runId: active.id });
    const detail = await fx.api.getRun(active.id);
    expect(detail.run.status).toBe("cancelled");
    // Nothing failed, so there is nothing to rerun by default.
    await expect(fx.api.rerun({ runId: active.id, reason: "try again" })).rejects.toThrow();

    const failed = [...fx.world.runs.values()].find((r) => r.status === "failure")!;
    const res = await fx.api.rerun({ runId: failed.id, reason: "flaky runner" });
    expect(res.runId).toBe(failed.id);
    expect(res.reruns.length).toBeGreaterThan(0);
    for (const r of res.reruns) {
      expect(r.previousState === "failure" || r.previousState === "infra_error").toBe(true);
      expect(fx.world.jobs.get(r.jobId)?.state).toBe("queued");
    }
    expect(fx.world.runs.get(failed.id)?.status).toBe("running");
  } finally {
    fx.stop();
  }
});

test("a held untrusted run approves only for the sha and workflow hash it shows", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "t4" });
  try {
    const held = [...fx.world.runs.values()].find(
      (r) => r.status === "awaiting_approval" && r.trustClass === "untrusted_pr",
    )!;
    expect(held.trustClass).toBe("untrusted_pr");
    const hash = held.trust!.workflowHash;
    await expect(
      fx.api.approveRun({ runId: held.id, headSha: "0".repeat(40), workflowHash: hash }),
    ).rejects.toThrow(/sha/);
    await expect(
      fx.api.approveRun({ runId: held.id, headSha: held.sha!, workflowHash: "bad" }),
    ).rejects.toThrow(/workflow/);
    expect(fx.world.runs.get(held.id)?.status).toBe("awaiting_approval");
    const ok = await fx.api.approveRun({ runId: held.id, headSha: held.sha!, workflowHash: hash });
    expect(ok.releasedJobs).toBeGreaterThan(0);
    expect(fx.world.runs.get(held.id)?.status).toBe("running");
    expect(fx.world.runs.get(held.id)?.trust?.decidedAt).not.toBeNull();
    await expect(
      fx.api.approveRun({ runId: held.id, headSha: held.sha!, workflowHash: hash }),
    ).rejects.toThrow();
  } finally {
    fx.stop();
  }
});

test("whoami reports the fixture role", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, role: "operator" });
  try {
    expect((await fx.api.whoami()).role).toBe("operator");
  } finally {
    fx.stop();
  }
});

test("failure digest, whole-log grep and ingest status answer from the fixture world", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "t5" });
  try {
    const failed = [...fx.world.runs.values()].find((r) => r.status === "failure")!;
    const d = await fx.api.failureDigest({ runId: failed.id });
    expect(d.failingJobs).toBeGreaterThan(0);
    expect(d.digests.every((x) => typeof x.excerpt === "string")).toBe(true);

    const att = [...fx.world.attempts.values()].find((a) => a.finishedAt !== null)!;
    const g = await fx.api.grepLog({
      attemptId: att.id,
      pattern: "e",
      ignoreCase: true,
      maxMatches: 5,
    });
    expect(g.matches).toBeGreaterThan(0);
    expect(g.hits.length).toBeLessThanOrEqual(5);
    expect(g.hits.every((h) => h.offset >= 0 && h.offset < g.totalBytes)).toBe(true);
    await expect(
      fx.api.grepLog({ attemptId: att.id, pattern: "(", regex: true }),
    ).rejects.toThrow();

    const ing = await fx.api.ingestStatus();
    expect(ing.repos.length).toBeGreaterThan(0);
    expect(ing.repos.some((r) => r.consecutiveFailures > 0)).toBe(true);
  } finally {
    fx.stop();
  }
});

test("cuts are metadata next to the log: reported by the API, never text in the bytes", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000 });
  try {
    const huge = [...fx.world.attempts.values()].find((a) => {
      const l = fx.world.logOf(a.id);
      return l !== null && l.cuts.length > 0;
    });
    expect(huge).toBeDefined();
    if (!huge) return;
    const cuts = await fx.api.jobCuts({ attemptId: huge.id });
    expect(cuts[0]).toMatchObject({ kind: "cut", attemptId: huge.id });
    const slice = await fx.api.jobLog({ attemptId: huge.id, offset: 0, limit: 1 << 30 });
    expect(new TextDecoder().decode(slice.bytes)).not.toContain("bytes of output omitted");
  } finally {
    fx.stop();
  }
});

test("fixture logs carry no inline step markers and no macOS legs", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "t4" });
  try {
    const attempt = [...fx.world.attempts.values()].find((a) => a.finishedAt !== null)!;
    const slice = await fx.api.jobLog({ attemptId: attempt.id, offset: 0, limit: 1 << 30 });
    expect(new TextDecoder().decode(slice.bytes)).not.toContain("::tt-");
    expect([...fx.world.jobs.values()].some((j) => /macos/i.test(j.name))).toBe(false);
  } finally {
    fx.stop();
  }
});
