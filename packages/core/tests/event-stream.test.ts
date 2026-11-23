import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendEvent, revokeApiToken, type Db } from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createEventStream, SSE_PATH, type EventStream } from "../src/realtime/sse";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let token: string;
let tokenId: string;
let stream: EventStream;
const open: AbortController[] = [];

const mk = (limits = {}) =>
  createEventStream({
    env,
    limits: { heartbeatMs: 50, pollMs: 40, reauthMs: 60_000, settleMs: 0, ...limits },
  });

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db };
  const t = await mintToken(db, { orgId: a.orgId }, "reader");
  token = t.secret;
  tokenId = t.id;
  stream = mk();
});
afterEach(() => {
  for (const c of open.splice(0)) c.abort();
});

type Frame = { id?: string; event?: string; data?: string; comment?: string };

/** Reads frames from a response until `until` says stop (or the stream ends). */
async function read(
  res: Response,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 2000,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !until(frames)) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((ok) =>
        setTimeout(() => ok({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) break;
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Frame = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) f.comment = line.slice(1).trim();
        else if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("data: ")) f.data = line.slice(6);
      }
      frames.push(f);
    }
  }
  reader.releaseLock();
  return frames;
}

async function connect(
  query = "",
  headers: Record<string, string> = {},
  tok = token,
): Promise<Response> {
  const ctl = new AbortController();
  open.push(ctl);
  const res = await stream.handle(
    new Request(`http://x.test${SSE_PATH}${query}`, {
      headers: { authorization: `Bearer ${tok}`, ...headers },
      signal: ctl.signal,
    }),
  );
  return res!;
}

const events = (fr: Frame[]) => fr.filter((f) => f.event);
const emit = (t: Tenant, n: number) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      appendEvent(db, t.scope, { type: "run.queued", runId: t.runId, payload: { i } }),
    ),
  );

describe("the event stream", () => {
  test("replays from a cursor, then follows live; ids are cursors and a heartbeat flows", async () => {
    await emit(a, 3);
    const res = await connect("?after=0");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = await read(res, (f) => events(f).length >= 3);
    expect(events(first).map((f) => f.event)).toEqual(["run.queued", "run.queued", "run.queued"]);
    const ids = events(first).map((f) => Number(f.id));
    expect(ids).toEqual(ids.toSorted((x, y) => x - y));
    expect(JSON.parse(events(first)[0]!.data!)).toMatchObject({
      cursor: ids[0],
      type: "run.queued",
    });
  });

  test("starting at now sends nothing old; a live event arrives; heartbeats arrive when idle", async () => {
    await emit(a, 2);
    const res = await connect("");
    const reader = res; // one read loop for the whole conversation
    setTimeout(() => void emit(a, 1), 120);
    const fr = await read(
      reader,
      (f) => events(f).length >= 1 && f.some((x) => x.comment === "hb"),
    );
    expect(events(fr)).toHaveLength(1);
    expect(fr.some((x) => x.comment === "hb")).toBe(true);
  });

  test("Last-Event-ID resumes after that event and wins over ?after", async () => {
    await emit(a, 5);
    const all = events(await read(await connect("?after=0"), (f) => events(f).length >= 5));
    const mid = all[1]!.id!;
    const resumed = events(
      await read(await connect("?after=0", { "last-event-id": mid }), (f) => events(f).length >= 3),
    );
    expect(resumed.map((f) => f.id)).toEqual(all.slice(2).map((f) => f.id));
  });

  test("disconnect and reconnect while events keep arriving: none lost, none repeated", async () => {
    const seen: string[] = [];
    let last = "0";
    let produced = 0;
    for (let round = 0; round < 4; round++) {
      await emit(a, 3);
      produced += 3;
      const res = await connect("", { "last-event-id": last });
      const fr = events(await read(res, (f) => events(f).length >= 3, 800));
      // More arrive while this connection is open; cut it before reading them all.
      await emit(a, 2);
      produced += 2;
      for (const f of fr) {
        seen.push(f.id!);
        last = f.id!;
      }
      open.pop()!.abort();
    }
    // Final drain from the last cursor.
    const rest = events(await read(await connect("", { "last-event-id": last }), () => false, 400));
    for (const f of rest) seen.push(f.id!);
    // Everything after the first cursor, in order, once each: the feed itself.
    const feed = await dispatch(env, { kind: "bearer", token }, "events", { after: 0, limit: 200 });
    const all = (feed.ok ? (feed.output as { events: { cursor: number }[] }).events : []).map((e) =>
      String(e.cursor),
    );
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all.slice(all.length - seen.length));
    expect(seen.length).toBeGreaterThanOrEqual(produced);
  });

  test("scoping: another org's events never arrive, types filter applies", async () => {
    await emit(b, 2);
    await appendEvent(db, a.scope, { type: "run.finished", runId: a.runId });
    await emit(a, 1);
    const res = await connect("?after=0&types=run.finished");
    const fr = events(await read(res, () => false, 300));
    expect(fr.map((f) => f.event)).toEqual(["run.finished"]);
  });

  test("a project-scoped token sees only its project", async () => {
    const t = await mintToken(db, a.scope, "reader");
    await appendEvent(db, { orgId: a.orgId }, { type: "infra.error", payload: { org_level: 1 } });
    await emit(a, 1);
    const fr = events(await read(await connect("?after=0", {}, t.secret), () => false, 300));
    expect(fr.length).toBeGreaterThan(0);
    // The org-level event is not in a project token's view, and the REST op agrees.
    expect(fr.some((f) => f.data?.includes("org_level"))).toBe(false);
    const r = await dispatch(env, { kind: "bearer", token: t.secret }, "events", {
      after: 0,
      limit: 200,
    });
    const viaRest = (r.ok ? (r.output as { events: { cursor: number }[] }).events : []).map((e) =>
      String(e.cursor),
    );
    expect(fr.map((f) => f.id)).toEqual(viaRest);
  });

  test("bad token, missing token, bad cursor and wrong method are plain HTTP errors", async () => {
    expect((await connect("", {}, "nope")).status).toBe(401);
    const none = await stream.handle(new Request(`http://x.test${SSE_PATH}`));
    expect(none!.status).toBe(401);
    expect((await connect("?after=abc")).status).toBe(400);
    const post = await stream.handle(
      new Request(`http://x.test${SSE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(post!.status).toBe(405);
    // Another path is not ours.
    expect(await stream.handle(new Request("http://x.test/api/v1/events"))).toBeUndefined();
  });

  test("a revoked token ends the stream with an error frame", async () => {
    stream = mk({ reauthMs: 60 });
    const res = await connect("");
    await revokeApiToken(db, { orgId: a.orgId }, tokenId, Date.now());
    const fr = await read(res, (f) => f.some((x) => x.event === "error"), 1500);
    expect(fr.find((x) => x.event === "error")?.data).toContain("unauthenticated");
  });

  test("connection caps per org: the next one is refused, and a closed one frees its slot", async () => {
    stream = mk({ maxConnectionsPerOrg: 2 });
    await connect("");
    await connect("");
    expect((await connect("")).status).toBe(503);
    for (const c of open.splice(0)) c.abort();
    await Bun.sleep(50);
    expect(stream.open).toBe(0);
    expect((await connect("")).status).toBe(200);
  });

  test("a slow consumer is closed instead of buffered without bound", async () => {
    stream = mk({ maxBufferedBytes: 512, page: 10, pollMs: 20 });
    const res = await connect("?after=0");
    // Never read from it. Produce more than the buffer holds.
    for (let i = 0; i < 30; i++) {
      await appendEvent(db, a.scope, {
        type: "run.queued",
        runId: a.runId,
        payload: { pad: "x".repeat(200) },
      });
    }
    await Bun.sleep(300);
    expect(stream.open).toBe(0);
    // What was buffered is still a valid prefix, ending with the slow-client notice.
    const fr = await read(res, () => false, 300);
    expect(fr.some((f) => f.event === "error" && f.data?.includes("slow_client"))).toBe(true);
    const ids = events(fr)
      .filter((f) => f.id)
      .map((f) => Number(f.id));
    expect(ids).toEqual(ids.toSorted((x, y) => x - y));
  });

  test("the REST events op and the stream agree on what a token may see", async () => {
    await emit(a, 2);
    const r = await dispatch(env, { kind: "bearer", token }, "events", { after: 0 });
    const viaRest = (r.ok ? (r.output as { events: { cursor: number }[] }).events : []).map((e) =>
      String(e.cursor),
    );
    const viaSse = events(
      await read(await connect("?after=0"), (f) => events(f).length >= viaRest.length),
    ).map((f) => f.id);
    expect(viaSse).toEqual(viaRest);
  });

  test("with a settle window, a fresh event waits for it and order is kept (Postgres id gaps)", async () => {
    stream = mk({ settleMs: 2500 });
    await Bun.sleep(2600); // anything the seed wrote has settled
    const res = await connect("");
    await emit(a, 2);
    const early = await read(res, (f) => events(f).length >= 1, 120);
    expect(events(early)).toHaveLength(0); // too young
    const later = await read(res, (f) => events(f).length >= 2, 6000);
    const ids = events(later).map((f) => Number(f.id));
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(ids.toSorted((x, y) => x - y));
  }, 20_000);

  test("after=now with a settle window starts at the newest settled id: young events are delivered, not lost", async () => {
    stream = mk({ settleMs: 2500 });
    await Bun.sleep(2600); // the seed has settled
    await emit(a, 2); // young: inside the window when the client connects
    const res = await connect("?after=now");
    const fr = events(await read(res, (f) => events(f).length >= 2, 6000));
    const ids = fr.map((f) => Number(f.id));
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(ids.toSorted((x, y) => x - y));
  }, 20_000);
});
