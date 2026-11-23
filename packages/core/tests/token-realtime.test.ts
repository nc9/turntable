// Revocation reaches realtime sockets (#435): revoke_api_token closes the token's open sockets at
// once, the periodic re-check closes an expired token's, and an unrevoked token's stays open.
// Runs on both dialects (TURNTABLE_TEST_DB).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendEvent, type Db } from "../src/db";
import { dispatch, type Principal, registry } from "../src/ops";
import { createRestApi } from "../src/ops/rest";
import { CLOSE, type ServerMessage } from "../src/realtime/protocol";
import { createRealtime, type Limits, type Realtime, type WsData } from "../src/realtime/server";
import { handleRequest } from "../src/server";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let server: ReturnType<typeof Bun.serve<WsData>>;
let rt: Realtime;
let base: string;

function start(limits: Partial<Limits> = {}) {
  const env = { registry, db };
  const api = createRestApi(env);
  rt = createRealtime({ env, limits });
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
  ({ db, a } = await seedWorld());
  // A short sweep: the periodic check is injectable.
  start({ sweepMs: 40 });
});

afterEach(async () => {
  rt.stop();
  await server.stop(true);
});

type Client = {
  ws: WebSocket;
  msgs: ServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
  isOpen(): boolean;
  until(pred: (m: ServerMessage) => boolean): Promise<void>;
};

async function connect(token: string): Promise<Client> {
  const ws = new WebSocket(`ws://${base}/api/v1/realtime`, ["turntable.v1", `bearer.${token}`]);
  const msgs: ServerMessage[] = [];
  ws.onmessage = (e) => void msgs.push(JSON.parse(String(e.data)) as ServerMessage);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  const until = async (pred: (m: ServerMessage) => boolean) => {
    for (let i = 0; i < 60; i++) {
      if (msgs.some(pred)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };
  return { ws, msgs, closed, isOpen: () => ws.readyState === WebSocket.OPEN, until };
}

const subscribe = async (c: Client) => {
  c.ws.send(JSON.stringify({ op: "subscribe", id: "o", topic: "org" }));
  await c.until((m) => m.type === "subscribed");
};

const admin = (): Principal => ({ kind: "member", id: "adm", orgId: a.orgId, role: "admin" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("revoking a token closes its open socket at once and no later event reaches it", async () => {
  // A long sweep proves the close comes from the revoke, not the periodic check.
  rt.stop();
  await server.stop(true);
  start({ sweepMs: 60_000 });
  const victim = await mintToken(db, { orgId: a.orgId }, "reader");
  const other = await mintToken(db, { orgId: a.orgId }, "reader");
  const c = await connect(victim.secret);
  const o = await connect(other.secret);
  await subscribe(c);
  await subscribe(o);
  const res = await dispatch(
    { registry, db, now: () => Date.now() },
    { kind: "principal", principal: admin() },
    "revoke_api_token",
    { token_id: victim.id, reason: "test" },
  );
  expect(res.ok).toBe(true);
  const closed = await c.closed;
  expect(closed.code).toBe(CLOSE.unauthenticated);
  // The reason names no secret.
  expect(closed.reason).not.toContain(victim.secret);
  await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
  await o.until((m) => m.type === "event");
  expect(c.msgs.some((m) => m.type === "event")).toBe(false);
  // The other token's socket stays open.
  expect(o.isOpen()).toBe(true);
});

test("a socket of an unrevoked token stays open across several sweeps", async () => {
  const t = await mintToken(db, { orgId: a.orgId }, "reader");
  const c = await connect(t.secret);
  await subscribe(c);
  await sleep(300);
  expect(c.isOpen()).toBe(true);
});

test("an expired token's socket is closed by the periodic check", async () => {
  const t = await mintToken(db, { orgId: a.orgId }, "reader", { expiresAt: Date.now() + 400 });
  const c = await connect(t.secret);
  await subscribe(c);
  expect((await c.closed).code).toBe(CLOSE.unauthenticated);
});
