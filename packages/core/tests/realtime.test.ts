import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import {
  addCut,
  appendEvent,
  appendLog,
  createProject,
  type Db,
  getRun,
  listEvents,
  revokeApiToken,
  transitionJob,
  updateAttempt,
  upsertStep,
} from "../src/db";
import { registry } from "../src/ops";
import { createRestApi } from "../src/ops/rest";
import { CLOSE, type ServerMessage } from "../src/realtime/protocol";
import { createRealtime, type Limits, type Realtime, type WsData } from "../src/realtime/server";
import { handleRequest } from "../src/server";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let reader: string;
let server: ReturnType<typeof Bun.serve<WsData>>;
let rt: Realtime;
let base: string;

function start(limits: Partial<Limits> = {}, allowedOrigins: string[] = []) {
  const env = { registry, db };
  const api = createRestApi(env);
  rt = createRealtime({ env, limits, allowedOrigins });
  server = Bun.serve<WsData>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const r = await rt.handle(req, srv);
      if (r === "upgraded") return undefined;
      if (r) return r;
      return handleRequest(req, api);
    },
    websocket: rt.websocket,
  });
  base = `127.0.0.1:${server.port}`;
}

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
  start();
});

afterEach(async () => {
  rt.stop();
  await server.stop(true);
});

// ---- helpers ----

type Client = {
  ws: WebSocket;
  msgs: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
  send(m: object): void;
  until(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  close(): void;
};

async function connect(
  token: string,
  opts: { origin?: string; protocols?: string[] } = {},
): Promise<Client> {
  const protocols = opts.protocols ?? ["longshore.v1", `bearer.${token}`];
  const ws = new WebSocket(`ws://${base}/api/v1/realtime`, {
    protocols,
    ...(opts.origin ? { headers: { Origin: opts.origin } } : {}),
  } as never);
  const msgs: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    msgs.push(JSON.parse(String(e.data)) as ServerMessage);
    for (const w of waiters.splice(0)) w();
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  const until = async (pred: (m: ServerMessage) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(`timed out; got ${JSON.stringify(msgs).slice(0, 600)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return {
    ws,
    msgs,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    until,
    close: () => ws.close(),
  };
}

/** A raw upgrade attempt through fetch, to see the refusal status the WebSocket client hides. */
async function upgrade(path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://${base}${path}`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      ...headers,
    },
  });
}

const events = (c: Client) =>
  c.msgs.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event");

// ---- auth and origin ----

test("a valid token connects and only the protocol name is echoed back, never the token", async () => {
  const c = await connect(reader);
  expect(c.ws.protocol).toBe("longshore.v1");
  c.close();
});

test("bad tokens, missing subprotocol and tokens in the query string are refused before upgrade", async () => {
  const bad = await upgrade("/api/v1/realtime", {
    "sec-websocket-protocol": "longshore.v1, bearer.tt_wrong",
  });
  expect(bad.status).toBe(401);
  const none = await upgrade("/api/v1/realtime", {});
  expect(none.status).toBe(401);
  const noName = await upgrade("/api/v1/realtime", {
    "sec-websocket-protocol": `bearer.${reader}`,
  });
  expect(noName.status).toBe(401);
  const query = await upgrade(`/api/v1/realtime?token=${reader}`, {
    "sec-websocket-protocol": `longshore.v1, bearer.${reader}`,
  });
  expect(query.status).toBe(400);
  expect(await query.text()).not.toContain(reader);
  const plain = await fetch(`http://${base}/api/v1/realtime`);
  expect(plain.status).toBe(426);
});

test("a revoked or expired token cannot connect", async () => {
  const revoked = await mintToken(db, { orgId: a.orgId }, "reader");
  expect(await revokeApiToken(db, { orgId: a.orgId }, revoked.id, Date.now())).toBe(true);
  const r = await upgrade("/api/v1/realtime", {
    "sec-websocket-protocol": `longshore.v1, bearer.${revoked.secret}`,
  });
  expect(r.status).toBe(401);
  const expired = await mintToken(db, { orgId: a.orgId }, "reader", {
    expiresAt: Date.now() - 1000,
  });
  const e = await upgrade("/api/v1/realtime", {
    "sec-websocket-protocol": `longshore.v1, bearer.${expired.secret}`,
  });
  expect(e.status).toBe(401);
});

test("origin: same-origin and allowlisted origins pass, others are refused, no Origin passes", async () => {
  rt.stop();
  await server.stop(true);
  start({}, ["https://ci.example.com"]);
  const proto = { "sec-websocket-protocol": `longshore.v1, bearer.${reader}` };
  expect(
    (await upgrade("/api/v1/realtime", { ...proto, origin: "https://evil.example" })).status,
  ).toBe(403);
  expect((await upgrade("/api/v1/realtime", { ...proto, origin: "null" })).status).toBe(403);
  const same = await connect(reader, { origin: `http://${base}` });
  same.close();
  const listed = await connect(reader, { origin: "https://ci.example.com" });
  listed.close();
  const noOrigin = await connect(reader);
  noOrigin.close();
});

// ---- grants ----

test("a token cannot subscribe outside its grant", async () => {
  const c = await connect(reader);
  // another org's run and attempt look exactly like ones that do not exist
  c.send({ op: "subscribe", id: "s1", topic: `run:${b.runId}` });
  c.send({ op: "subscribe", id: "s2", topic: `attempt:${b.attemptId}:log` });
  c.send({ op: "subscribe", id: "s3", topic: `attempt:${b.attemptId}:steps` });
  c.send({ op: "subscribe", id: "s4", topic: "project:no-such-project" });
  c.send({ op: "subscribe", id: "s5", topic: "bogus:thing" });
  for (const id of ["s1", "s2", "s3", "s4"]) {
    const m = (await c.until((x) => x.type === "error" && x.id === id)) as Extract<
      ServerMessage,
      { type: "error" }
    >;
    expect(m.code).toBe("not_found");
  }
  const bogus = (await c.until((x) => x.type === "error" && x.id === "s5")) as Extract<
    ServerMessage,
    { type: "error" }
  >;
  expect(bogus.code).toBe("invalid_input");
  expect(c.msgs.some((m) => m.type === "subscribed")).toBe(false);
  // and it does receive its own org's run
  c.send({ op: "subscribe", id: "ok", topic: `run:${a.runId}` });
  await c.until((m) => m.type === "subscribed" && m.id === "ok");
  c.close();
});

test("events from another org never reach a subscriber", async () => {
  const c = await connect(reader);
  c.send({ op: "subscribe", id: "o", topic: "org" });
  await c.until((m) => m.type === "subscribed");
  await appendEvent(db, b.scope, { type: "run.queued", runId: b.runId });
  const mine = await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  await c.until((m) => m.type === "event" && m.event.cursor === mine);
  expect(events(c).every((e) => e.event.run_id !== b.runId)).toBe(true);
  c.close();
});

test("a project-scoped token sees only its project, and cannot name a sibling", async () => {
  const p2 = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
  const scope2 = { orgId: a.orgId, projectId: p2.id };
  const scoped = (await mintToken(db, a.scope, "reader")).secret; // project-scoped to `app`
  const c = await connect(scoped);
  c.send({ op: "subscribe", id: "sib", topic: "project:other" });
  const err = (await c.until((m) => m.type === "error" && m.id === "sib")) as Extract<
    ServerMessage,
    { type: "error" }
  >;
  expect(err.code).toBe("not_found");
  c.send({ op: "subscribe", id: "org", topic: "org" });
  await c.until((m) => m.type === "subscribed");
  await appendEvent(db, scope2, { type: "run.queued" });
  const own = await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  await c.until((m) => m.type === "event" && m.event.cursor === own);
  expect(events(c).map((e) => e.event.project)).toEqual(["app"]);
  c.close();
});

// ---- replay then live ----

test("replay then live has no gap and no duplicate, even with events committing during replay", async () => {
  for (let i = 0; i < 40; i++)
    await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  const c = await connect(reader);
  c.send({ op: "subscribe", id: "r", topic: "org", after: 0 });
  // keep committing while the replay is in flight
  let produced = (await listEvents(db, a.scope, { after: 0, limit: 1000 })).length;
  const writer = (async () => {
    for (let i = 0; i < 120; i++) {
      await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
      produced++;
      if (i % 7 === 0) await new Promise((r) => setTimeout(r, 1));
    }
  })();
  await writer;
  const all = await listEvents(db, a.scope, { after: 0, limit: 1000 });
  expect(all.length).toBe(produced);
  await c.until((m) => m.type === "event" && m.event.cursor === all.at(-1)!.id);
  expect(events(c).map((e) => e.event.cursor)).toEqual(all.map((e) => e.id));
  c.close();
});

test("a reconnect resumes from the last cursor: nothing lost, nothing repeated", async () => {
  const first = await connect(reader);
  first.send({ op: "subscribe", id: "x", topic: "org", after: 0 });
  await first.until((m) => m.type === "subscribed");
  let last = 0;
  for (let i = 0; i < 5; i++)
    last = await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  await first.until((m) => m.type === "event" && m.event.cursor === last);
  first.close();
  await first.closed;
  const missed: number[] = [];
  for (let i = 0; i < 4; i++)
    missed.push(await appendEvent(db, a.scope, { type: "run.started", runId: a.runId }));
  const second = await connect(reader);
  second.send({ op: "subscribe", id: "x", topic: "org", after: last });
  const ack = (await second.until((m) => m.type === "subscribed")) as Extract<
    ServerMessage,
    { type: "subscribed" }
  >;
  expect(ack.cursor).toBe(last);
  const live = await appendEvent(db, a.scope, { type: "run.finished", runId: a.runId });
  await second.until((m) => m.type === "event" && m.event.cursor === live);
  expect(events(second).map((e) => e.event.cursor)).toEqual([...missed, live]);
  second.close();
});

test("omitting `after` starts from now: history is not replayed", async () => {
  await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  const c = await connect(reader);
  c.send({ op: "subscribe", id: "n", topic: "org" });
  await c.until((m) => m.type === "subscribed");
  const next = await appendEvent(db, a.scope, { type: "run.started", runId: a.runId });
  await c.until((m) => m.type === "event");
  expect(events(c).map((e) => e.event.cursor)).toEqual([next]);
  c.close();
});

test("a run topic delivers only that run's events", async () => {
  const c = await connect(reader);
  c.send({ op: "subscribe", id: "run", topic: `run:${a.runId}` });
  await c.until((m) => m.type === "subscribed");
  await appendEvent(db, a.scope, { type: "run.queued", runId: "someone-else" });
  const mine = await appendEvent(db, a.scope, { type: "run.started", runId: a.runId });
  await c.until((m) => m.type === "event" && m.event.cursor === mine);
  expect(events(c).map((e) => e.event.run_id)).toEqual([a.runId]);
  c.close();
});

// ---- logs ----

test("log tail: chunks arrive in order with offsets, from an offset, then eof when the attempt ends", async () => {
  const text1 = "line one\nline two\n";
  let at = 0;
  at = await appendAt(text1, at);
  const c = await connect(reader);
  c.send({ op: "subscribe", id: "log", topic: `attempt:${a.attemptId}:log`, from_offset: 0 });
  const ack = (await c.until((m) => m.type === "subscribed")) as Extract<
    ServerMessage,
    { type: "subscribed" }
  >;
  expect(ack.offset).toBe(0);
  await c.until((m) => m.type === "log" && m.offset === 0);
  at = await appendAt("line three\n", at);
  at = await appendAt("line four\n", at);
  await updateAttempt(db, a.scope, a.attemptId, { state: "running" });
  await transitionJob(db, a.scope, a.jobId, "running");
  await updateAttempt(db, a.scope, a.attemptId, { state: "success", exitCode: 0 });
  await transitionJob(db, a.scope, a.jobId, "success", { exitCode: 0 });
  await c.until((m) => m.type === "log" && m.eof === true);
  const logs = c.msgs.filter(
    (m): m is Extract<ServerMessage, { type: "log" }> => m.type === "log" && m.bytes > 0,
  );
  let expected = 0;
  let joined = "";
  for (const l of logs) {
    expect(l.offset).toBe(expected);
    expected = l.offset + l.bytes;
    joined += l.text;
  }
  expect(joined).toBe("line one\nline two\nline three\nline four\n");
  expect(expected).toBe(at);
  // a later subscriber can start mid-log
  const late = await connect(reader);
  late.send({
    op: "subscribe",
    id: "late",
    topic: `attempt:${a.attemptId}:log`,
    from_offset: text1.length,
  });
  await late.until((m) => m.type === "log" && m.eof === true);
  const lateText = late.msgs
    .filter((m) => m.type === "log")
    .map((m) => (m as { text: string }).text)
    .join("");
  expect(lateText).toBe("line three\nline four\n");
  c.close();
  late.close();
});

async function appendAt(text: string, at: number): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  await appendLog(db, a.scope, a.attemptId, at, bytes);
  return at + bytes.length;
}

test("steps and cuts are separate messages that follow changes; the log topic carries cuts too", async () => {
  const steps = await connect(reader);
  steps.send({ op: "subscribe", id: "st", topic: `attempt:${a.attemptId}:steps` });
  await steps.until((m) => m.type === "steps");
  expect((steps.msgs.find((m) => m.type === "steps") as { steps: unknown[] }).steps).toEqual([]);
  await upsertStep(db, a.scope, {
    attemptId: a.attemptId,
    stepKey: "build",
    stage: "main",
    index: 1,
    name: "Build",
    logOffset: 10,
  });
  await steps.until((m) => m.type === "steps" && m.steps.length === 1);
  await upsertStep(db, a.scope, {
    attemptId: a.attemptId,
    stepKey: "build",
    stage: "main",
    index: 1,
    name: "Build",
    result: "success",
    logOffset: 10,
  });
  await steps.until((m) => m.type === "steps" && m.steps[0]?.result === "success");
  await addCut(db, a.scope, {
    attemptId: a.attemptId,
    atOffset: 50,
    omittedBytes: 4096,
    reason: "head",
  });
  await steps.until((m) => m.type === "steps" && m.cuts.length === 1);

  const log = await connect(reader);
  log.send({ op: "subscribe", id: "lg", topic: `attempt:${a.attemptId}:log` });
  const cuts = (await log.until((m) => m.type === "cuts")) as Extract<
    ServerMessage,
    { type: "cuts" }
  >;
  expect(cuts.cuts).toEqual([{ at_offset: 50, omitted_bytes: 4096, reason: "head" }]);
  steps.close();
  log.close();
});

// ---- backpressure ----

/** Minimal frame reader for server frames (unmasked). Returns the first close frame's code. */
function closeCode(buf: Buffer): number | null {
  let p = 0;
  while (p + 2 <= buf.length) {
    const op = buf[p]! & 0x0f;
    let len = buf[p + 1]! & 0x7f;
    let head = 2;
    if (len === 126) {
      if (p + 4 > buf.length) return null;
      len = buf.readUInt16BE(p + 2);
      head = 4;
    } else if (len === 127) {
      if (p + 10 > buf.length) return null;
      len = Number(buf.readBigUInt64BE(p + 2));
      head = 10;
    }
    if (p + head + len > buf.length) return null;
    if (op === 8) return len >= 2 ? buf.readUInt16BE(p + head) : 1005;
    p += head + len;
  }
  return null;
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

test("a slow client is dropped with the slow-client code instead of buffering without bound", async () => {
  rt.stop();
  await server.stop(true);
  start({ maxBufferedBytes: 64 * 1024 });
  // a big log the client will not read
  const chunk = new TextEncoder().encode(`${"x".repeat(1023)}\n`.repeat(256)); // 256 KiB
  let at = 0;
  for (let i = 0; i < 24; i++) {
    await appendLog(db, a.scope, a.attemptId, at, chunk);
    at += chunk.length;
  }
  const key = randomBytes(16).toString("base64");
  const socket = net.connect(server.port!, "127.0.0.1");
  socket.pause();
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "GET /api/v1/realtime HTTP/1.1",
      `Host: ${base}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Protocol: longshore.v1, bearer.${reader}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(
    maskedTextFrame(
      JSON.stringify({ op: "subscribe", id: "big", topic: `attempt:${a.attemptId}:log` }),
    ),
  );
  // do not read for a while: the kernel buffers fill and the server's buffer grows past the limit
  await new Promise((r) => setTimeout(r, 1500));
  const chunks: Buffer[] = [];
  let code = null as number | null;
  await new Promise<void>((resolve) => {
    socket.on("data", (d: Buffer) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const body = all.subarray(all.indexOf("\r\n\r\n") + 4);
      code = closeCode(body);
      if (code !== null) resolve();
    });
    socket.on("close", () => resolve());
    socket.resume();
    setTimeout(resolve, 8000);
  });
  expect(Buffer.concat(chunks).toString("latin1")).toContain(accept);
  expect(code).toBe(CLOSE.slowClient);
  socket.destroy();
  expect(rt.stats().connections).toBe(0);
});

// ---- limits and hygiene ----

test("per-org connection and per-connection subscription caps", async () => {
  rt.stop();
  await server.stop(true);
  start({ maxConnectionsPerOrg: 1, maxSubscriptionsPerConnection: 1 });
  const first = await connect(reader);
  const second = await upgrade("/api/v1/realtime", {
    "sec-websocket-protocol": `longshore.v1, bearer.${reader}`,
  });
  expect(second.status).toBe(429);
  first.send({ op: "subscribe", id: "one", topic: "org" });
  await first.until((m) => m.type === "subscribed");
  first.send({ op: "subscribe", id: "two", topic: `run:${a.runId}` });
  const err = (await first.until((m) => m.type === "error" && m.id === "two")) as Extract<
    ServerMessage,
    { type: "error" }
  >;
  expect(err.code).toBe("limit");
  first.send({ op: "unsubscribe", id: "one" });
  first.send({ op: "subscribe", id: "three", topic: `run:${a.runId}` });
  await first.until((m) => m.type === "subscribed" && m.id === "three");
  first.close();
});

test("concurrent upgrades cannot exceed the per-org connection cap", async () => {
  rt.stop();
  await server.stop(true);
  start({ maxConnectionsPerOrg: 3 });
  // Drive handle() directly with a server whose upgrade() accepts but never opens, so every
  // upgrade is "pending": only the reservation made before upgrade() can enforce the cap.
  let accept = true;
  const fake = { upgrade: () => accept } as unknown as Parameters<typeof rt.handle>[1];
  const mk = () =>
    new Request(`http://${base}/api/v1/realtime`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        host: base,
        "sec-websocket-protocol": `longshore.v1, bearer.${reader}`,
      },
    });
  const results = await Promise.all(Array.from({ length: 12 }, () => rt.handle(mk(), fake)));
  expect(results.filter((r) => r === "upgraded").length).toBe(3);
  expect(results.filter((r) => r instanceof Response && r.status === 429).length).toBe(9);
  // a failed upgrade gives its slot back
  accept = false;
  expect((await rt.handle(mk(), fake)) instanceof Response).toBe(true); // still full: refused with 429
  rt.stop();
  await server.stop(true);
  start({ maxConnectionsPerOrg: 1 });
  const refused = await rt.handle(mk(), fake);
  expect(refused instanceof Response && refused.status).toBe(400); // upgrade failed, not capped
  accept = true;
  expect(await rt.handle(mk(), fake)).toBe("upgraded"); // the failed attempt released its slot
  expect(await rt.handle(mk(), fake)).toBeInstanceOf(Response); // and now it is full
});

test("real concurrent connections still stop at the cap, and a freed slot is reusable", async () => {
  rt.stop();
  await server.stop(true);
  start({ maxConnectionsPerOrg: 3 });
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => connect(reader)));
  const ok = attempts.filter((r): r is PromiseFulfilledResult<Client> => r.status === "fulfilled");
  expect(ok.length).toBe(3);
  expect(rt.stats().connections).toBe(3);
  ok[0]!.value.close();
  await ok[0]!.value.closed;
  const again = await connect(reader);
  expect(rt.stats().connections).toBe(3);
  again.close();
  for (const r of ok) r.value.close();
});

test("malformed and binary messages close the connection with the protocol code", async () => {
  const bad = await connect(reader);
  bad.ws.send("not json");
  expect((await bad.closed).code).toBe(CLOSE.protocol);
  const bin = await connect(reader);
  bin.ws.send(new Uint8Array([1, 2, 3]));
  expect((await bin.closed).code).toBe(CLOSE.protocol);
  const big = await connect(reader);
  big.ws.send(JSON.stringify({ op: "subscribe", id: "x", topic: "a".repeat(5000) }));
  expect((await big.closed).code).toBe(CLOSE.protocol);
});

test("a token revoked mid-connection ends the connection", async () => {
  rt.stop();
  await server.stop(true);
  start({ sweepMs: 40 });
  const minted = await mintToken(db, { orgId: a.orgId }, "reader");
  const c = await connect(minted.secret);
  c.send({ op: "subscribe", id: "o", topic: "org" });
  await c.until((m) => m.type === "subscribed");
  await revokeApiToken(db, { orgId: a.orgId }, minted.id, Date.now());
  expect((await c.closed).code).toBe(CLOSE.unauthenticated);
});

test("an idle connection with no subscriptions is closed", async () => {
  rt.stop();
  await server.stop(true);
  start({ sweepMs: 30, idleNoSubscriptionMs: 80 });
  const c = await connect(reader);
  expect((await c.closed).code).toBe(CLOSE.idle);
});

test("the run still exists untouched (sanity: the helpers did not mutate other tenants)", async () => {
  expect(await getRun(db, b.scope, b.runId)).toBeDefined();
});
