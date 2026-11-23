import { describe, expect, test } from "bun:test";
import type { TurntableApi } from "../src/api/client";
import type { Realtime, RealtimeMessage, Topic } from "../src/api/realtime";
import type { Run } from "../src/api/types";
import { createWsRealtime, type WsRealtimeOptions } from "../src/api/ws-adapter";

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {}
  // test controls
  open() {
    this.onopen?.();
  }
  push(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const last = () => FakeSocket.all.at(-1)!;
const subsOf = (s: FakeSocket) => s.sent.filter((m) => m.op === "subscribe");

const run = (id: string, status: Run["status"] = "running"): Run => ({
  id,
  orgId: "acme",
  projectId: "api",
  workflowPath: "ci.yml",
  workflowName: "ci",
  event: "push",
  ref: "refs/heads/main",
  sha: null,
  commitMessage: "ci on main",
  actor: "",
  status,
  createdAt: 1,
  startedAt: null,
  finishedAt: null,
});

function setup(over: Partial<WsRealtimeOptions> = {}) {
  FakeSocket.all = [];
  let runs = [run("r1")];
  const calls = { listRuns: 0 };
  const api = {
    listRuns: async () => {
      calls.listRuns++;
      return { runs, nextCursor: null };
    },
    getRun: async () => ({ run: runs[0]!, jobs: [], attempts: [] }),
  } as unknown as TurntableApi;
  const fallbackSubs: { topic: Topic; off: boolean }[] = [];
  const fallback: Realtime = {
    subscribe(topic) {
      const rec = { topic, off: false };
      fallbackSubs.push(rec);
      return () => void (rec.off = true);
    },
    status: () => "polling",
    onStatus: () => () => {},
  };
  let unauth = 0;
  const rt = createWsRealtime({
    url: "ws://localhost/api/v1/realtime",
    token: () => "tt_secret",
    api,
    fallback,
    onUnauthenticated: () => unauth++,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    baseMs: 5,
    maxMs: 20,
    fallbackAfter: 3,
    refreshDebounceMs: 5,
    ...over,
  });
  return { rt, calls, setRuns: (r: Run[]) => (runs = r), fallbackSubs, unauth: () => unauth };
}

describe("connection", () => {
  test("offers the subprotocols and never puts the token in the URL", () => {
    const { rt } = setup();
    rt.subscribe({ kind: "org", orgId: "acme" }, {}, () => {});
    const s = last();
    expect(s.protocols).toEqual(["turntable.v1", "bearer.tt_secret"]);
    expect(s.url).toBe("ws://localhost/api/v1/realtime");
    expect(s.url).not.toContain("tt_secret");
    expect(rt.status()).toBe("connecting");
    s.open();
    expect(rt.status()).toBe("live");
  });

  test("no token, no socket", () => {
    const { rt } = setup({ token: () => null });
    rt.subscribe({ kind: "org", orgId: "acme" }, {}, () => {});
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe("event topics", () => {
  test("a push refreshes the snapshot and emits only what changed; replayed cursors are ignored", async () => {
    const { rt, calls, setRuns } = setup();
    const got: RealtimeMessage[] = [];
    rt.subscribe({ kind: "project", projectId: "api" }, {}, (m) => got.push(m));
    const s = last();
    s.open();
    const sub = subsOf(s)[0]!;
    expect(sub).toMatchObject({ op: "subscribe", topic: "project:api" });
    expect(sub).not.toHaveProperty("after"); // first time: from now
    s.push({ type: "subscribed", id: sub.id, topic: "project:api", cursor: 41 });
    await wait(30);
    expect(got.filter((m) => m.type === "change")).toHaveLength(1); // initial snapshot
    const before = calls.listRuns;

    setRuns([run("r1", "success")]);
    s.push({
      type: "event",
      id: sub.id,
      event: {
        cursor: 42,
        type: "run.finished",
        id: "e",
        project: "api",
        run_id: "r1",
        job_id: null,
        attempt_id: null,
        payload: {},
        created_at: "",
      },
    });
    s.push({
      type: "event",
      id: sub.id,
      event: {
        cursor: 42,
        type: "run.finished",
        id: "e",
        project: "api",
        run_id: "r1",
        job_id: null,
        attempt_id: null,
        payload: {},
        created_at: "",
      },
    }); // replay
    s.push({
      type: "event",
      id: sub.id,
      event: {
        cursor: 40,
        type: "run.queued",
        id: "old",
        project: "api",
        run_id: "r1",
        job_id: null,
        attempt_id: null,
        payload: {},
        created_at: "",
      },
    }); // older
    await wait(40);
    expect(calls.listRuns - before).toBe(1); // one refresh for the burst
    const changes = got.filter((m) => m.type === "change");
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ entity: "run", value: { id: "r1", status: "success" } });
  });

  test("unsubscribe tells the server and stops delivery", async () => {
    const { rt } = setup();
    const got: RealtimeMessage[] = [];
    const off = rt.subscribe({ kind: "run", runId: "r1" }, {}, (m) => got.push(m));
    const s = last();
    s.open();
    const id = subsOf(s)[0]!.id;
    off();
    expect(s.sent.at(-1)).toEqual({ op: "unsubscribe", id });
    s.push({ type: "subscribed", id, topic: "run:r1", cursor: 1 });
    await wait(20);
    expect(got.filter((m) => m.type === "change")).toHaveLength(0);
  });
});

describe("attempt topics", () => {
  const topic: Topic = { kind: "attempt-log", attemptId: "att1" };

  test("log chunks keep exact offsets, duplicates are dropped, steps and cuts arrive out of band", async () => {
    const { rt } = setup();
    const got: RealtimeMessage[] = [];
    rt.subscribe(topic, { offset: 100 }, (m) => got.push(m));
    const s = last();
    s.open();
    const subs = subsOf(s);
    expect(subs.map((m) => [m.topic, m.from_offset])).toEqual([
      ["attempt:att1:log", 100],
      ["attempt:att1:steps", undefined],
    ]);
    const log = subs[0]!.id;
    const steps = subs[1]!.id;
    s.push({ type: "log", id: log, offset: 100, bytes: 6, text: "hello\n" });
    s.push({ type: "log", id: log, offset: 100, bytes: 6, text: "hello\n" }); // replay
    s.push({ type: "log", id: log, offset: 106, bytes: 4, text: "café" }); // 5 bytes in UTF-8, server said 4
    s.push({ type: "log", id: log, offset: 110, bytes: 0, text: "", eof: true });
    const chunks = got.filter(
      (m): m is Extract<RealtimeMessage, { type: "log" }> => m.type === "log",
    );
    expect(chunks.map((c) => [c.offset, c.data.length, c.eof ?? false])).toEqual([
      [100, 6, false],
      [106, 4, false],
      [110, 0, true],
    ]);
    s.push({
      type: "steps",
      id: steps,
      steps: [
        {
          key: "a",
          stage: "main",
          index: 1,
          name: "Setup",
          result: "success",
          started_at: "2026-11-22T10:00:00.000Z",
          finished_at: "2026-11-22T10:00:02.000Z",
          duration_ms: 2000,
          log_offset: 100,
        },
        {
          key: "b",
          stage: "main",
          index: 2,
          name: "Test",
          result: null,
          started_at: "2026-11-22T10:00:02.000Z",
          finished_at: null,
          duration_ms: null,
          log_offset: 106,
        },
      ],
      cuts: [{ at_offset: 106, omitted_bytes: 4096, reason: "head" }],
    });
    const stepMsgs = got.filter((m) => m.type === "step");
    expect(
      stepMsgs.map(
        (m) =>
          (m as { phase: string; index: number; logOffset: number }).phase +
          (m as { index: number }).index,
      ),
    ).toEqual(["start1", "end1", "start2"]);
    expect(stepMsgs[1]).toMatchObject({ attemptId: "att1", result: "success", logOffset: 106 }); // ends where the next begins
    expect(got.find((m) => m.type === "cut")).toMatchObject({
      attemptId: "att1",
      kind: "cut",
      atOffset: 106,
      omittedBytes: 4096,
    });
  });
});

describe("reconnect and fallback", () => {
  test("reconnects with backoff and resumes each topic from its last cursor and offset", async () => {
    const { rt } = setup();
    rt.subscribe({ kind: "org", orgId: "acme" }, {}, () => {});
    rt.subscribe({ kind: "attempt-log", attemptId: "att1" }, {}, () => {});
    const first = last();
    first.open();
    const [orgSub, logSub] = subsOf(first);
    first.push({ type: "subscribed", id: orgSub!.id, topic: "org", cursor: 10 });
    first.push({
      type: "event",
      id: orgSub!.id,
      event: {
        cursor: 12,
        type: "run.queued",
        id: "e",
        project: null,
        run_id: null,
        job_id: null,
        attempt_id: null,
        payload: {},
        created_at: "",
      },
    });
    first.push({ type: "log", id: logSub!.id, offset: 0, bytes: 3, text: "abc" });
    first.drop(1006);
    expect(rt.status()).toBe("reconnecting");
    await wait(40);
    expect(FakeSocket.all.length).toBe(2);
    const second = last();
    second.open();
    expect(rt.status()).toBe("live");
    const again = subsOf(second);
    expect(again.find((m) => m.topic === "org")).toMatchObject({ after: 12 });
    expect(again.find((m) => m.topic === "attempt:att1:log")).toMatchObject({ from_offset: 3 });
  });

  test("a slow-client drop reconnects at once and a rejected token stops for good", async () => {
    const { rt, unauth } = setup({ baseMs: 1000, maxMs: 1000 });
    rt.subscribe({ kind: "org", orgId: "acme" }, {}, () => {});
    const s = last();
    s.open();
    s.drop(4408);
    await wait(15);
    expect(FakeSocket.all.length).toBe(2); // did not wait the 1000 ms backoff
    const t = last();
    t.open();
    t.drop(4401);
    expect(rt.status()).toBe("offline");
    expect(unauth()).toBe(1);
    await wait(30);
    expect(FakeSocket.all.length).toBe(2);
  });

  test("when sockets keep failing, subscriptions run on polling; a socket that opens later takes over", async () => {
    const { rt, fallbackSubs } = setup({ fallbackAfter: 2, baseMs: 2, maxMs: 4 });
    rt.subscribe({ kind: "project", projectId: "api" }, {}, () => {});
    last().drop(1006); // never opened
    await wait(15);
    last().drop(1006);
    expect(rt.status()).toBe("polling");
    expect(fallbackSubs).toHaveLength(1);
    expect(fallbackSubs[0]!.off).toBe(false);
    // the background retry is slow once on fallback (>= 5 s); open the pending socket by hand
    await wait(5);
    const retrying = FakeSocket.all.length;
    expect(retrying).toBe(2);
  });

  test("a server-side refusal of one topic moves just that topic to polling", () => {
    const { rt, fallbackSubs } = setup();
    rt.subscribe({ kind: "run", runId: "nope" }, {}, () => {});
    const s = last();
    s.open();
    const id = subsOf(s)[0]!.id;
    s.push({ type: "error", id, code: "not_found", message: "run not found" });
    expect(fallbackSubs.map((f) => f.topic)).toEqual([{ kind: "run", runId: "nope" }]);
  });

  test("a socket that opens after fallback hands the subscription back to push", async () => {
    const { rt, fallbackSubs } = setup({
      fallbackAfter: 1,
      baseMs: 1,
      maxMs: 1,
      fallbackRetryMs: 10,
    });
    rt.subscribe({ kind: "org", orgId: "acme" }, {}, () => {});
    last().drop(1006);
    expect(rt.status()).toBe("polling");
    expect(fallbackSubs[0]!.off).toBe(false);
    await wait(40);
    expect(FakeSocket.all.length).toBe(2); // the background retry
    const s = last();
    s.open();
    expect(rt.status()).toBe("live");
    expect(fallbackSubs[0]!.off).toBe(true);
    expect(subsOf(s).map((m) => m.topic)).toEqual(["org"]);
  });
});
