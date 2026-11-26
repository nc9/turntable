import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import { startServer } from "../src/server";
import { VERSION } from "../src/version";
import { mintToken, seedWorld } from "./ops-helpers";
import type { Db } from "../src/db";

let db: Db;
let token: string;
let server: ReturnType<typeof startServer>;
let plain: ReturnType<typeof startServer>;
let throwing: ReturnType<typeof startServer>;
let base: string;

beforeAll(async () => {
  const w = await seedWorld();
  db = w.db;
  token = (await mintToken(db, { orgId: w.a.orgId }, "reader")).secret;
  server = startServer({ port: 0, host: "127.0.0.1", db });
  base = `http://127.0.0.1:${server.port}`;
  // Believes x-forwarded-proto, so a request claiming http is redirected or rejected.
  plain = startServer({
    port: 0,
    host: "127.0.0.1",
    db,
    transport: { trustForwardedProto: true, hstsMaxAge: 0, hstsIncludeSubDomains: false },
  });
  throwing = startServer({
    port: 0,
    host: "127.0.0.1",
    db,
    webhooks: {
      handle: async () => {
        throw new Error("boom");
      },
    } as never,
  });
});
afterAll(async () => {
  await server.stop(true);
  await plain.stop(true);
  await throwing.stop(true);
  db.close();
});

const h = (res: Response): string | null => res.headers.get("turntable-version");

test("the header is on /healthz, the shell, an API 401, a 404 and a 405", async () => {
  for (const [path, method, status] of [
    ["/healthz", "GET", 200],
    ["/", "GET", 200],
    ["/openapi.json", "GET", 200],
    ["/api/v1/runs", "GET", 401],
    ["/nope", "GET", 404],
    ["/healthz", "POST", 405],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method });
    expect(res.status).toBe(status);
    expect(h(res)).toBe(VERSION);
  }
});

test("served /openapi.json info.version is the live version", async () => {
  const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { info: { version: string } };
  expect(doc.info.version).toBe(VERSION);
});

test("an MCP response carries the header", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  expect(h(res)).toBe(VERSION);
  await res.body?.cancel();
});

test("the plain-http redirect and the reject carry the header", async () => {
  const pb = `http://127.0.0.1:${plain.port}`;
  const redirect = await fetch(`${pb}/healthz`, {
    redirect: "manual",
    headers: { "x-forwarded-proto": "http" },
  });
  expect(redirect.status).toBe(301);
  expect(h(redirect)).toBe(VERSION);
  const reject = await fetch(`${pb}/healthz`, {
    method: "POST",
    headers: { "x-forwarded-proto": "http" },
  });
  expect(reject.status).not.toBe(200);
  expect(h(reject)).toBe(VERSION);
});

test("an SSE stream carries the header and keeps streaming", async () => {
  const res = await fetch(`${base}/api/v1/events/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(h(res)).toBe(VERSION);
  const reader = res.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  await reader.cancel();
});

test("a thrown handler error is a 500 with the header", async () => {
  const res = await fetch(`http://127.0.0.1:${throwing.port}/api/v1/webhooks/github`, {
    method: "POST",
    body: "{}",
  });
  expect(res.status).toBe(500);
  expect(h(res)).toBe(VERSION);
});

test("the WebSocket 101 carries the header", async () => {
  const head = await new Promise<string>((resolve, reject) => {
    const sock = net.connect(server.port!, "127.0.0.1", () => {
      sock.write(
        [
          "GET /api/v1/realtime HTTP/1.1",
          `Host: 127.0.0.1:${server.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Protocol: turntable.v1, bearer.${token}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    sock.once("data", (d) => {
      sock.destroy();
      resolve(d.toString());
    });
    sock.once("error", reject);
  });
  expect(head).toContain("101");
  expect(head.toLowerCase()).toContain(`turntable-version: ${VERSION.toLowerCase()}`);
});
