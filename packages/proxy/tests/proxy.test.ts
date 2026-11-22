// The proxy's guarantees, one test per property (see docs/secrets-proxy.mdx). Clients dial the
// proxy on 127.0.0.1; the upstream is a recording stand-in unless a test says otherwise.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import net from "node:net";
import tls from "node:tls";
import { createHttpClient, type SafeFetch } from "@longshore/net";
import { JobCa } from "../src/ca";
import { type RunningProxy, sourceKey, startProxy } from "../src/proxy";
import { AttemptRegistry } from "../src/registry";
import type { AuditEvent, AuditSink, Rule, SecretScope, SecretSource } from "../src/types";

const SECRET = "tok_live_1234567890abcdef";
const HOST = "registry.example.test";

// Certificates are checked against the real clock, so the test clock starts there.
let clock = Date.now();
const registry = new AttemptRegistry({ now: () => clock });
let proxy: RunningProxy;
let events: AuditEvent[] = [];
let auditFails = false;
const audit: AuditSink = {
  async record(e) {
    if (auditFails && e.kind === "inject") throw new Error("audit down");
    events.push(e);
  },
};
const scopes: SecretScope[] = [];
let secretValue: string | undefined = SECRET;
const source: SecretSource = {
  async resolve(scope) {
    scopes.push(scope);
    return secretValue === undefined
      ? { ok: false, reason: "missing" }
      : { ok: true, value: secretValue };
  },
};

type Seen = { url: string; method: string; headers: Headers; body: string };
let seen: Seen[] = [];
let handler: (s: Seen) => Response = () => new Response("ok");
const upstream: SafeFetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const body = init?.body ? Buffer.from(init.body as Uint8Array).toString() : "";
  const s = { url: String(input), method: init?.method ?? "GET", headers, body };
  seen.push(s);
  return handler(s);
};

const rules = (over: Partial<Rule> = {}): Rule[] => [
  {
    id: "npm",
    host: HOST,
    methods: ["GET", "POST"],
    pathPrefix: "/v1/",
    inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    secret: "NPM_TOKEN",
    ...over,
  },
];

let n = 0;
function newAttempt(r: Rule[] = rules(), ttlMs = 60_000) {
  const attemptId = `att${++n}`;
  const cred = registry.register({
    attemptId,
    orgId: "org",
    projectId: "proj",
    runId: "run",
    jobId: "job",
    rules: r,
    ttlMs,
  });
  return { attemptId, cred };
}
const basic = (u: string, p: string): string =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

interface Tunnel {
  status: number;
  head: string;
  /** The TLS socket, when the tunnel was established. */
  secure?: tls.TLSSocket;
  raw: net.Socket;
  /** Sends one request and reads one response. */
  request(
    text: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string; raw: string }>;
  closed: Promise<void>;
  close(): void;
}

/** Dials the proxy, sends CONNECT, and (if allowed) completes TLS trusting the attempt's CA. */
async function tunnel(o: {
  auth: string | undefined;
  authority?: string;
  ca?: string;
  servername?: string;
  request?: string;
}): Promise<Tunnel> {
  const raw = net.connect(proxy.port, proxy.host);
  await new Promise<void>((r, j) => {
    raw.once("connect", () => r());
    raw.once("error", j);
  });
  const closed = new Promise<void>((r) => raw.once("close", () => r()));
  const authority = o.authority ?? `${HOST}:443`;
  raw.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${o.auth ? `Proxy-Authorization: ${o.auth}\r\n` : ""}\r\n`,
  );
  const head = await new Promise<string>((resolve) => {
    let buf = "";
    raw.on("data", function onData(d) {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        raw.off("data", onData);
        resolve(buf);
      }
    });
    raw.once("close", () => resolve(buf));
  });
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
  const t: Tunnel = {
    status,
    head,
    raw,
    closed,
    close: () => raw.destroy(),
    request: async () => ({ status: 0, headers: {}, body: "", raw: "" }),
  };
  if (status !== 200) return t;
  const secure = tls.connect({
    socket: raw,
    servername: o.servername ?? authority.split(":")[0]!,
    ca: o.ca,
    // A hostile job picks its own server name and need not check the name on the certificate.
    ...(o.servername ? { checkServerIdentity: () => undefined } : {}),
    ALPNProtocols: ["http/1.1"],
  });
  await new Promise<void>((r) => {
    secure.once("secureConnect", () => r());
    secure.once("error", () => r());
    secure.once("close", () => r());
  });
  t.secure = secure;
  secure.on("error", () => {});
  t.request = (text) =>
    new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const finish = (): void => {
        secure.off("data", onData);
        const raw = buf.toString("latin1");
        const headEnd = raw.indexOf("\r\n\r\n");
        const lines = (headEnd < 0 ? raw : raw.slice(0, headEnd)).split("\r\n");
        const headers: Record<string, string> = {};
        for (const l of lines.slice(1)) {
          const i = l.indexOf(":");
          if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
        resolve({
          status: Number(/^HTTP\/1\.1 (\d+)/.exec(lines[0] ?? "")?.[1] ?? 0),
          headers,
          body: headEnd < 0 ? "" : raw.slice(headEnd + 4),
          raw,
        });
      };
      const complete = (): boolean => {
        const raw = buf.toString("latin1");
        const headEnd = raw.indexOf("\r\n\r\n");
        if (headEnd < 0) return false;
        const len = /content-length: (\d+)/i.exec(raw.slice(0, headEnd))?.[1];
        return len === undefined || buf.length >= headEnd + 4 + Number(len);
      };
      const onData = (d: Buffer): void => {
        buf = Buffer.concat([buf, d]);
        if (complete()) finish();
      };
      secure.on("data", onData);
      secure.once("close", finish);
      secure.write(text);
    });
  return t;
}

const get = (path: string, extra = "", host = HOST): string =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}\r\n`;
const reasons = (): string[] => events.filter((e) => e.kind === "deny").map((e) => e.reason ?? "");

beforeAll(async () => {
  proxy = await startProxy({
    registry,
    source,
    audit,
    upstream,
    now: () => clock,
    limits: { idleMs: 5000 },
  });
});
afterAll(async () => {
  await proxy.close();
});
beforeEach(() => {
  events = [];
  seen = [];
  scopes.length = 0;
  auditFails = false;
  secretValue = SECRET;
  handler = () => new Response("ok", { headers: { "content-type": "text/plain" } });
});

describe("injection scope", () => {
  test("a credential is injected for the host, method and path prefix the rule names", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect(t.status).toBe(200);
    const r = await t.request(get("/v1/pkg?x=1"));
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${HOST}/v1/pkg?x=1`);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(events.filter((e) => e.kind === "inject")).toHaveLength(1);
    t.close();
  });

  test("a host with no rule for the job is refused at CONNECT and audited", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({
      auth: basic(cred.username, cred.password),
      authority: "evil.example.test:443",
    });
    expect(t.status).toBe(403);
    expect(reasons()).toContain("no_rule_for_host");
    // Nor a port the rule does not name.
    const p = await tunnel({
      auth: basic(cred.username, cred.password),
      authority: `${HOST}:8443`,
    });
    expect(p.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test("a method or path outside the rule is refused and never reaches the upstream", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(`DELETE /v1/pkg HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)).status).toBe(403);
    const t2 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t2.request(get("/v2/pkg"))).status).toBe(403);
    expect(
      (
        await (
          await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem })
        ).request(get("/v10/x"))
      ).status,
    ).toBe(403);
    expect(seen).toHaveLength(0);
    expect(reasons()).toEqual(expect.arrayContaining(["no_rule_for_method", "no_rule_for_path"]));
  });

  test("a rule is evaluated for every request of a keep-alive tunnel", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/a"))).status).toBe(200);
    // The same tunnel, a path outside the rule: refused. The first success does not carry over.
    expect((await t.request(get("/admin"))).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  test.each([
    ["dot segments", "/v1/../admin"],
    ["encoded dot segments", "/v1/%2e%2e/admin"],
    ["an encoded slash", "/v1/a%2fb"],
    ["a backslash", "/v1/a%5cb"],
    ["an empty segment", "/v1//a"],
    ["a matrix parameter that makes a dot segment upstream", "/v1/..;/admin"],
    ["a matrix parameter after a single dot", "/v1/.;x/admin"],
    ["any matrix parameter", "/v1/a;b=c"],
    ["an upper-case encoded dot", "/v1/%2E%2E/admin"],
    ["an upper-case encoded slash", "/v1/a%2Fb"],
  ])("a path that is not canonical is refused, never normalised: %s", async (_name, path) => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get(path))).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(reasons().some((r) => r.startsWith("path_"))).toBe(true);
  });
});

describe("where the upstream address comes from", () => {
  test("the inner Host header must equal the tunnelled host", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/a", "", "other.example.test"))).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(reasons()).toContain("host_mismatch");
  });

  test("the TLS server name must equal the tunnelled host", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({
      auth: basic(cred.username, cred.password),
      ca: cred.caPem,
      servername: "other.example.test",
    });
    await Promise.race([t.closed, Bun.sleep(1000)]);
    expect(reasons()).toContain("sni_mismatch");
    expect(seen).toHaveLength(0);
  });

  test("an absolute-form target and plain HTTP proxying are refused", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const abs = await t.request(
      `GET https://other.example.test/v1/a HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
    );
    expect(abs.status).toBe(400);
    expect(reasons()).toContain("absolute_form");
    // Not a CONNECT at all.
    const raw = net.connect(proxy.port, proxy.host);
    await new Promise<void>((r) => raw.once("connect", () => r()));
    raw.write(
      `GET http://${HOST}/v1/a HTTP/1.1\r\nHost: ${HOST}\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
    );
    const answer = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
    expect(answer.startsWith("HTTP/1.1 405")).toBe(true);
    expect(reasons()).toContain("not_connect");
    raw.destroy();
    expect(seen).toHaveLength(0);
  });

  test("an upstream that resolves to an internal address is refused (no rebinding)", async () => {
    const guarded = await startProxy({
      registry,
      source,
      audit,
      now: () => clock,
      upstream: createHttpClient({ resolve: async () => ["127.0.0.1"] }).fetch,
    });
    try {
      const { cred } = newAttempt();
      const raw = net.connect(guarded.port, guarded.host);
      await new Promise<void>((r) => raw.once("connect", () => r()));
      raw.write(
        `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
      );
      await new Promise<void>((r) => raw.once("data", () => r()));
      const secure = tls.connect({ socket: raw, servername: HOST, ca: cred.caPem });
      await new Promise<void>((r) => secure.once("secureConnect", () => r()));
      secure.write(get("/v1/a"));
      const answer = await new Promise<string>((r) => secure.once("data", (d) => r(d.toString())));
      expect(answer.startsWith("HTTP/1.1 502")).toBe(true);
      expect(reasons()).toContain("upstream_blocked");
      secure.destroy();
    } finally {
      await guarded.close();
    }
  });
});

describe("the job's proxy credential", () => {
  test("unknown, wrong and another attempt's credentials get the same answer", async () => {
    const one = newAttempt();
    const two = newAttempt();
    const answers: string[] = [];
    for (const auth of [
      basic("nobody", "x"),
      basic(one.attemptId, "wrong"),
      basic(one.attemptId, two.cred.password),
      undefined,
    ]) {
      const t = await tunnel({ auth });
      expect(t.status).toBe(407);
      answers.push(t.head);
    }
    expect(new Set(answers).size).toBe(1);
    expect(events.filter((e) => e.kind === "auth_failure").map((e) => e.reason)).toEqual([
      "unknown_attempt",
      "bad_credential",
      "bad_credential",
      "malformed",
    ]);
    expect(seen).toHaveLength(0);
  });

  test("expired attempt credential refused, at CONNECT and inside an open tunnel", async () => {
    const { attemptId, cred } = newAttempt(rules(), 5_000);
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/a"))).status).toBe(200);
    clock += 5_000;
    // The open tunnel: the next request ends it.
    await t.request(get("/v1/a"));
    await Promise.race([t.closed, Bun.sleep(1000)]);
    expect(seen).toHaveLength(1);
    // A new tunnel with the same credential.
    const late = await tunnel({ auth: basic(attemptId, cred.password) });
    expect(late.status).toBe(407);
    expect(events.filter((e) => e.kind === "auth_failure").map((e) => e.reason)).toContain(
      "expired",
    );
    clock -= 5_000;
  });

  test("open tunnels are closed when the attempt is revoked", async () => {
    const { attemptId, cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/a"))).status).toBe(200);
    registry.revoke(attemptId);
    await Promise.race([t.closed, Bun.sleep(2000)]);
    expect(t.raw.destroyed).toBe(true);
    const again = await tunnel({ auth: basic(attemptId, cred.password) });
    expect(again.status).toBe(407);
  });

  test("the proxy credential is not forwarded upstream", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(
      get(
        "/v1/a",
        `Proxy-Authorization: ${basic(cred.username, cred.password)}\r\nProxy-Connection: keep-alive\r\n`,
      ),
    );
    expect(seen[0]!.headers.get("proxy-authorization")).toBeNull();
    expect(seen[0]!.headers.get("proxy-connection")).toBeNull();
  });
});

describe("redirects and responses", () => {
  test("credential not sent after a cross-host redirect: the proxy never follows one", async () => {
    handler = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example.test/steal" },
      });
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a"));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://other.example.test/steal");
    expect(seen).toHaveLength(1);
    // The job follows it through the proxy, and that host has no rule.
    const next = await tunnel({
      auth: basic(cred.username, cred.password),
      authority: "other.example.test:443",
    });
    expect(next.status).toBe(403);
    expect(seen.filter((s) => s.url.includes("other.example.test"))).toHaveLength(0);
  });

  test("an injected value echoed in a response, in any form, is redacted before the job sees it", async () => {
    handler = (s) =>
      new Response(
        `body ${SECRET} and ${Buffer.from(SECRET).toString("base64")} and ${encodeURIComponent(SECRET)}`,
        {
          headers: {
            "x-echo": s.headers.get("authorization") ?? "",
            "set-cookie": `session=${SECRET}; Path=/`,
          },
        },
      );
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a"));
    expect(r.status).toBe(200);
    expect(r.raw).not.toContain(SECRET);
    expect(r.raw).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(r.headers["x-echo"]).toBe("***");
    expect(r.body).toContain("***");
    // The length matches what was actually sent.
    expect(Buffer.byteLength(r.body)).toBe(Number(r.headers["content-length"]));
    expect(events.some((e) => e.kind === "redact")).toBe(true);
  });

  test("a Basic credential echoed back is redacted in every form", async () => {
    handler = (s) => new Response(`auth was ${s.headers.get("authorization")}`);
    const { cred } = newAttempt(
      rules({ inject: { type: "basic", username: "ci" }, pathPrefix: "/" }),
    );
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/anything"));
    expect(r.body).toBe("auth was ***");
    expect(seen[0]!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`ci:${SECRET}`).toString("base64")}`,
    );
  });

  test("a compressed response to a request that carried a credential is refused", async () => {
    handler = () =>
      new Response(gzipSync(Buffer.from(SECRET)), { headers: { "content-encoding": "gzip" } });
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a", "Accept-Encoding: gzip\r\n"));
    expect(r.status).toBe(502);
    expect(r.raw).not.toContain(SECRET);
    expect(seen[0]!.headers.get("accept-encoding")).toBe("identity");
    expect(reasons()).toContain("encoded_response");
  });

  test("a job's own copy of an injected header is replaced, never added to", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(get("/v1/a", "Authorization: Bearer the-job-made-this-up\r\n"));
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  test("a request body reaches the upstream, chunked or not", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(`POST /v1/a HTTP/1.1\r\nHost: ${HOST}\r\ncontent-length: 5\r\n\r\nhello`);
    await t.request(
      `POST /v1/a HTTP/1.1\r\nHost: ${HOST}\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n`,
    );
    expect(seen.map((s) => s.body)).toEqual(["hello", "abcde"]);
  });
});

describe("request framing", () => {
  test.each([
    [
      "both content-length and transfer-encoding",
      "content-length: 3\r\ntransfer-encoding: chunked\r\n",
    ],
    ["a duplicate content-length", "content-length: 3\r\ncontent-length: 3\r\n"],
    ["an upgrade request", "upgrade: websocket\r\nconnection: upgrade\r\n"],
    ["an unsupported transfer-encoding", "transfer-encoding: gzip\r\n"],
  ])("a request with %s is refused", async (_name, extra) => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(`POST /v1/a HTTP/1.1\r\nHost: ${HOST}\r\n${extra}\r\nabc`);
    expect(r.status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(reasons().some((x) => x.startsWith("bad_request_"))).toBe(true);
  });

  test("two Host headers are refused", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(
      `GET /v1/a HTTP/1.1\r\nHost: ${HOST}\r\nHost: other.example.test\r\n\r\n`,
    );
    expect(r.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("secrets and audit", () => {
  test("the secret source gets ids and the destination, and a value is never in an audit event", async () => {
    const { attemptId, cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(get("/v1/a"));
    expect(scopes).toEqual([
      { orgId: "org", projectId: "proj", runId: "run", jobId: "job", attemptId, host: HOST },
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("Bearer");
  });

  test("a secret the source cannot give, or one too short to redact, is not injected", async () => {
    const { cred } = newAttempt();
    secretValue = undefined;
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/a"))).status).toBe(502);
    secretValue = "short";
    const t2 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t2.request(get("/v1/a"))).status).toBe(502);
    expect(seen).toHaveLength(0);
    expect(reasons()).toEqual(expect.arrayContaining(["secret_unavailable", "secret_too_short"]));
  });

  test("if the audit write fails, nothing is injected", async () => {
    auditFails = true;
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a"));
    expect(r.status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  test("a rule that injects nothing forwards the job's own headers untouched", async () => {
    const { cred } = newAttempt(
      rules({ inject: { type: "none" }, secret: undefined, pathPrefix: "/" }),
    );
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(get("/any", "Authorization: Bearer the-jobs-own\r\n"));
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer the-jobs-own");
    expect(scopes).toHaveLength(0);
  });
});

describe("the per-job CA", () => {
  test("a tunnel is not trusted by another attempt's CA", async () => {
    const one = newAttempt();
    const two = newAttempt();
    const raw = net.connect(proxy.port, proxy.host);
    await new Promise<void>((r) => raw.once("connect", () => r()));
    raw.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(one.cred.username, one.cred.password)}\r\n\r\n`,
    );
    await new Promise<void>((r) => raw.once("data", () => r()));
    const secure = tls.connect({ socket: raw, servername: HOST, ca: two.cred.caPem });
    const outcome = await new Promise<string>((r) => {
      secure.once("secureConnect", () => r("connected"));
      secure.once("error", (e) => r(e.message));
    });
    expect(outcome).not.toBe("connected");
  });
});

describe("scanning covers the whole attempt", () => {
  const twoRules = (): Rule[] => [
    ...rules(),
    {
      id: "public",
      host: HOST,
      methods: ["GET"],
      pathPrefix: "/public/",
      inject: { type: "none" },
    },
  ];

  test("partial-content requests are stripped once the attempt has injected, and a 206 is refused", async () => {
    const { cred } = newAttempt(twoRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    // The injecting request itself, asking for a range.
    await t.request(get("/v1/a", "Range: bytes=0-10\r\nIf-Range: x\r\n"));
    expect(seen[0]!.headers.get("range")).toBeNull();
    expect(seen[0]!.headers.get("if-range")).toBeNull();
    // A later request on a rule that injects nothing: same attempt, same rule.
    await t.request(get("/public/a", "Range: bytes=0-10\r\nIf-None-Match: *\r\nIf-Match: x\r\n"));
    expect(seen[1]!.headers.get("range")).toBeNull();
    expect(seen[1]!.headers.get("if-none-match")).toBeNull();
    expect(seen[1]!.headers.get("if-match")).toBeNull();
    handler = () =>
      new Response("part", { status: 206, headers: { "content-range": "bytes 0-3/9" } });
    const r = await t.request(get("/public/b"));
    expect(r.status).toBe(502);
    expect(reasons()).toContain("partial_response");
  });

  test("an attempt that has injected nothing is not touched by these rules", async () => {
    const { cred } = newAttempt(twoRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    handler = () =>
      new Response("part", { status: 206, headers: { "content-range": "bytes 0-3/9" } });
    const r = await t.request(get("/public/a", "Range: bytes=0-3\r\n"));
    expect(r.status).toBe(206);
    expect(seen[0]!.headers.get("range")).toBe("bytes=0-3");
  });

  test("a long piece of an injected value left in a response is refused", async () => {
    handler = () => new Response(`prefix ${SECRET.slice(0, 16)} and more`);
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a"));
    expect(r.status).toBe(502);
    expect(r.raw).not.toContain(SECRET.slice(0, 16));
    expect(reasons()).toContain("partial_secret_in_response");
    // The end of the value, too.
    handler = () => new Response(`tail ${SECRET.slice(-16)}`);
    const t2 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t2.request(get("/v1/a"))).status).toBe(502);
  });

  test("after an injection, a compressed response to any request of the attempt is refused", async () => {
    const { cred } = newAttempt(twoRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    handler = () =>
      new Response(gzipSync(Buffer.from("fine")), { headers: { "content-encoding": "gzip" } });
    // Before anything was injected: passed through, still labelled as compressed.
    const before = await t.request(get("/public/a"));
    expect(before.status).toBe(200);
    expect(before.headers["content-encoding"]).toBe("gzip");
    handler = () => new Response("ok");
    expect((await t.request(get("/v1/a"))).status).toBe(200);
    // Now every later response must be readable by the scrubber.
    handler = () =>
      new Response(gzipSync(Buffer.from(SECRET)), { headers: { "content-encoding": "gzip" } });
    const after = await t.request(get("/public/a"));
    expect(after.status).toBe(502);
    expect(after.raw).not.toContain(SECRET);
    expect(reasons()).toContain("encoded_response");
  });

  test("a chunk trailer with no end is refused rather than buffered", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(
      `POST /v1/a HTTP/1.1\r\nHost: ${HOST}\r\ntransfer-encoding: chunked\r\n\r\n0\r\n${"x".repeat(20_000)}`,
    );
    expect(r.status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(reasons()).toContain("bad_request_bad_trailer");
  });
});

describe("the tunnel cap holds under a burst", () => {
  test("concurrent CONNECTs cannot pass the check while the audit write is pending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let failTunnels = false;
    const slow: AuditSink = {
      async record(e) {
        if (e.kind === "tunnel") {
          await gate;
          if (failTunnels) throw new Error("audit down");
        }
        events.push(e);
      },
    };
    const capped = await startProxy({
      registry,
      source,
      audit: slow,
      upstream,
      now: () => clock,
      limits: { tunnelsPerAttempt: 3, idleMs: 5000 },
    });
    const dial = async (cred: { username: string; password: string }): Promise<string> => {
      const raw = net.connect(capped.port, capped.host);
      await new Promise<void>((r) => raw.once("connect", () => r()));
      raw.write(
        `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
      );
      const head = await new Promise<string>((r) => {
        raw.once("data", (d) => r(d.toString("latin1")));
        raw.once("close", () => r(""));
      });
      if (!head.startsWith("HTTP/1.1 200")) raw.destroy();
      sockets.push(raw);
      return head.slice(0, 12);
    };
    const sockets: net.Socket[] = [];
    try {
      const { cred } = newAttempt();
      // Ten at once; every audit write waits on the gate.
      const all = Array.from({ length: 10 }, () => dial(cred));
      await Bun.sleep(300);
      release();
      const heads = await Promise.all(all);
      expect(heads.filter((h) => h === "HTTP/1.1 200")).toHaveLength(3);
      expect(heads.filter((h) => h === "HTTP/1.1 429")).toHaveLength(7);
      for (const s of sockets) s.destroy();
      await Bun.sleep(100);

      // A failed audit write gives its slot back.
      failTunnels = true;
      const second = newAttempt();
      const failed = await Promise.all(Array.from({ length: 3 }, () => dial(second.cred)));
      expect(failed.every((h) => h === "HTTP/1.1 502")).toBe(true);
      failTunnels = false;
      expect(await dial(second.cred)).toBe("HTTP/1.1 200");
    } finally {
      for (const s of sockets) s.destroy();
      release();
      await capped.close();
    }
  });
});

describe("an attempt revoked while its tunnel is being audited", () => {
  test("gets no tunnel", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: AuditSink = {
      async record(e) {
        if (e.kind === "tunnel") await gate;
        events.push(e);
      },
    };
    const p2 = await startProxy({ registry, source, audit: slow, upstream, now: () => clock });
    try {
      const { attemptId, cred } = newAttempt();
      const raw = net.connect(p2.port, p2.host);
      await new Promise<void>((r) => raw.once("connect", () => r()));
      raw.write(
        `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
      );
      await Bun.sleep(200);
      registry.revoke(attemptId);
      release();
      const got = await new Promise<string>((r) => {
        raw.once("data", (d) => r(d.toString("latin1")));
        raw.once("close", () => r(""));
      });
      expect(got.startsWith("HTTP/1.1 200")).toBe(false);
      raw.destroy();
    } finally {
      release();
      await p2.close();
    }
  });
});

describe("what the proxy says and forwards", () => {
  test("the upstream's reason phrase is never passed on: the status line is ours", async () => {
    handler = () => new Response("ok", { status: 200, statusText: SECRET });
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(get("/v1/a"));
    expect(r.raw.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(r.raw).not.toContain(SECRET);
    handler = () => new Response(null, { status: 418, statusText: "I am a teapot" });
    const odd = await t.request(get("/v1/b"));
    expect(odd.raw.startsWith("HTTP/1.1 418 Client Error\r\n")).toBe(true);
    handler = () => new Response(null, { status: 404, statusText: "whatever upstream says" });
    expect((await t.request(get("/v1/c"))).raw.startsWith("HTTP/1.1 404 Not Found\r\n")).toBe(true);
  });

  test("a rule that injects forwards an allowlist of headers, so a method override cannot ride along", async () => {
    const { cred } = newAttempt();
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(
      get(
        "/v1/a",
        [
          "Accept: application/json",
          "Accept-Language: en",
          "User-Agent: job/1",
          "X-HTTP-Method-Override: DELETE",
          "X-HTTP-Method: DELETE",
          "X-Method-Override: DELETE",
          "X-Forwarded-Host: evil.example.test",
          "X-Original-URL: /admin",
          "X-Custom: nope",
          "Cookie: session=abc",
        ].join("\r\n") + "\r\n",
      ),
    );
    const h = seen[0]!.headers;
    expect(h.get("accept")).toBe("application/json");
    expect(h.get("accept-language")).toBe("en");
    expect(h.get("user-agent")).toBe("job/1");
    for (const dropped of [
      "x-http-method-override",
      "x-http-method",
      "x-method-override",
      "x-forwarded-host",
      "x-original-url",
      "x-custom",
      "cookie",
    ]) {
      expect(h.get(dropped)).toBeNull();
    }
    expect(seen[0]!.method).toBe("GET");
  });

  test("a rule can name extra headers to forward, but never a method override", async () => {
    const { cred } = newAttempt(rules({ forwardHeaders: ["X-Request-Id"] }));
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(get("/v1/a", "X-Request-Id: abc\r\nX-Other: no\r\n"));
    expect(seen[0]!.headers.get("x-request-id")).toBe("abc");
    expect(seen[0]!.headers.get("x-other")).toBeNull();
    expect(() => newAttempt(rules({ forwardHeaders: ["X-HTTP-Method-Override"] }))).toThrow();
    expect(() => newAttempt(rules({ forwardHeaders: ["Authorization:x"] }))).toThrow();
  });

  test("a rule that injects nothing forwards the job's headers, minus the method overrides", async () => {
    const { cred } = newAttempt(
      rules({ inject: { type: "none" }, secret: undefined, pathPrefix: "/" }),
    );
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    await t.request(get("/any", "X-Custom: kept\r\nX-HTTP-Method-Override: DELETE\r\n"));
    expect(seen[0]!.headers.get("x-custom")).toBe("kept");
    expect(seen[0]!.headers.get("x-http-method-override")).toBeNull();
  });
});

describe("passthrough tunnels", () => {
  test("a host with no rule gets a plain tunnel only when the attempt lists it", async () => {
    // A TCP echo server stands in for the destination.
    const echo = net.createServer((c) => c.on("data", (d) => c.write(`echo:${d}`)));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    const port = (echo.address() as net.AddressInfo).port;
    const p2 = await startProxy({
      registry,
      source,
      audit,
      upstream,
      tunnel: async (_h, pt) => net.connect(pt, "127.0.0.1"),
      now: () => clock,
    });
    const dial = async (cred: { username: string; password: string }, authority: string) => {
      const raw = net.connect(p2.port, p2.host);
      await new Promise<void>((r) => raw.once("connect", () => r()));
      raw.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
      );
      const head = await new Promise<string>((r) => {
        raw.once("data", (d) => r(d.toString("latin1")));
        raw.once("close", () => r(""));
      });
      return { raw, head };
    };
    try {
      // Refused without passthrough.
      const closed = newAttempt();
      const a = await dial(closed.cred, `other.example.test:${port}`);
      expect(a.head.startsWith("HTTP/1.1 403")).toBe(true);
      a.raw.destroy();
      expect(reasons()).toContain("no_rule_for_host");

      // Allowed with it: bytes flow, no certificate is minted, and the audit says passthrough.
      const attemptId = `att${++n}`;
      const cred = registry.register({
        attemptId,
        orgId: "org",
        projectId: "proj",
        runId: "run",
        jobId: "job",
        rules: rules(),
        passthroughHosts: [
          { host: "other.example.test", ports: [port] },
          { host: "*.cdn.example.test", ports: [port] },
        ],
        ttlMs: 60_000,
      });
      const b = await dial(cred, `other.example.test:${port}`);
      expect(b.head.startsWith("HTTP/1.1 200")).toBe(true);
      const echoed = await new Promise<string>((r) => {
        b.raw.once("data", (d) => r(d.toString()));
        b.raw.write("hello");
      });
      expect(echoed).toBe("echo:hello");
      expect(events.some((e) => e.kind === "tunnel" && e.reason === "passthrough")).toBe(true);
      // Revoking the attempt cuts the tunnel.
      const gone = new Promise<void>((r) => b.raw.once("close", () => r()));
      registry.revoke(attemptId);
      await gone;
      // Only the listed hosts: another host, or the bare suffix of a wildcard, is still refused.
      const other = registry.register({
        attemptId: `att${++n}`,
        orgId: "org",
        projectId: "proj",
        runId: "run",
        jobId: "job",
        rules: rules(),
        passthroughHosts: [
          { host: "other.example.test", ports: [port] },
          { host: "*.cdn.example.test", ports: [port] },
        ],
        ttlMs: 60_000,
      });
      for (const host of [
        "third.example.test",
        "cdn.example.test",
        "other.example.test.evil.test",
      ]) {
        const d = await dial(other, `${host}:${port}`);
        expect(d.head.startsWith("HTTP/1.1 403")).toBe(true);
        d.raw.destroy();
      }
      // Only the listed ports: the same host on another port is refused, and nothing is dialled.
      for (const wrong of [port + 1, 443, 22]) {
        const d = await dial(other, `other.example.test:${wrong}`);
        expect(d.head.startsWith("HTTP/1.1 403")).toBe(true);
        d.raw.destroy();
      }
      const wild = await dial(other, `a.cdn.example.test:${port}`);
      expect(wild.head.startsWith("HTTP/1.1 200")).toBe(true);
      wild.raw.destroy();
      // A host WITH a rule is still intercepted, never passed through.
      const c = await dial(
        registry.register({
          attemptId: `att${++n}`,
          orgId: "org",
          projectId: "proj",
          runId: "run",
          jobId: "job",
          rules: rules(),
          passthroughHosts: [{ host: "other.example.test", ports: [port] }],
          ttlMs: 60_000,
        }),
        `${HOST}:443`,
      );
      expect(c.head.startsWith("HTTP/1.1 200")).toBe(true);
      c.raw.destroy();
    } finally {
      await p2.close();
      echo.close();
    }
  });
});

describe("a public TLS listener and its limits", () => {
  const LISTEN_NAME = "proxy.example.test";
  // The listener's certificate: a leaf for its public name from a throwaway CA (a test stand-in
  // for the platform's public certificate).
  const listenerCa = new JobCa({ label: "listener", now: Date.now(), ttlMs: 3_600_000 });
  const leaf = listenerCa.leafFor(LISTEN_NAME);
  const started: RunningProxy[] = [];
  afterAll(async () => {
    for (const p of started) await p.close();
  });
  const start = async (
    over: Partial<Parameters<typeof startProxy>[0]> = {},
  ): Promise<RunningProxy> => {
    const p = await startProxy({
      registry,
      source,
      audit,
      upstream,
      now: () => clock,
      ...over,
    });
    started.push(p);
    return p;
  };

  /** Dials the listener over TLS, verifying its name, and sends one CONNECT. */
  async function overTls(p: RunningProxy, auth: string | undefined): Promise<string> {
    const sock = tls.connect({
      host: "127.0.0.1",
      port: p.port,
      servername: LISTEN_NAME,
      ca: listenerCa.certPem,
    });
    await new Promise<void>((r, j) => {
      sock.once("secureConnect", () => r());
      sock.once("error", j);
    });
    sock.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
    );
    const head = await new Promise<string>((r) => {
      sock.once("data", (d) => r(d.toString("latin1")));
      sock.once("close", () => r(""));
    });
    sock.destroy();
    return head;
  }

  test("CONNECT and the credential travel inside TLS: a good credential gets a tunnel, a bad one a 407", async () => {
    const p = await start({ tls: { key: leaf.key, cert: leaf.cert } });
    const { cred } = newAttempt();
    expect((await overTls(p, basic(cred.username, cred.password))).startsWith("HTTP/1.1 200")).toBe(
      true,
    );
    expect((await overTls(p, basic(cred.username, "wrong"))).startsWith("HTTP/1.1 407")).toBe(true);
    expect((await overTls(p, undefined)).startsWith("HTTP/1.1 407")).toBe(true);
  });

  test("a plain-text client gets nothing from the TLS listener, and its credential is not read", async () => {
    const p = await start({ tls: { key: leaf.key, cert: leaf.cert } });
    const { cred } = newAttempt();
    const raw = net.connect(p.port, "127.0.0.1");
    await new Promise<void>((r) => raw.once("connect", () => r()));
    raw.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
    );
    const got = await new Promise<string>((r) => {
      raw.on("data", (d) => r(d.toString("latin1")));
      raw.once("close", () => r(""));
      setTimeout(() => r(""), 1500);
    });
    expect(got.startsWith("HTTP/1.1 200")).toBe(false);
    expect(got).not.toContain("Connection Established");
    raw.destroy();
  });

  test("a client that does not trust the listener's name does not get as far as sending anything", async () => {
    const p = await start({ tls: { key: leaf.key, cert: leaf.cert } });
    const bad = tls.connect({
      host: "127.0.0.1",
      port: p.port,
      servername: "other.example.test",
      ca: listenerCa.certPem,
    });
    const failed = await new Promise<boolean>((r) => {
      bad.once("secureConnect", () => r(false));
      bad.once("error", () => r(true));
    });
    expect(failed).toBe(true);
  });

  /** Opens a TCP connection and resolves when it is up. */
  const dial = async (p: RunningProxy): Promise<net.Socket> => {
    const s = net.connect(p.port, "127.0.0.1");
    await new Promise<void>((r, j) => {
      s.once("connect", () => r());
      s.once("error", j);
    });
    return s;
  };
  const closedWithin = (s: net.Socket, ms: number): Promise<boolean> =>
    new Promise((r) => {
      s.once("close", () => r(true));
      setTimeout(() => r(false), ms);
    });
  /** One CONNECT with the given Authorization on a fresh connection; returns the head and the time taken. */
  const connectOnce = async (
    p: RunningProxy,
    auth: string,
  ): Promise<{ head: string; ms: number }> => {
    const t0 = Date.now();
    const s = await dial(p);
    s.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    const head = await new Promise<string>((r) => {
      s.once("data", (d) => r(d.toString("latin1")));
      s.once("close", () => r(""));
    });
    s.destroy();
    return { head, ms: Date.now() - t0 };
  };

  test("connections that have not authenticated are capped per source, and a slot comes back when one closes", async () => {
    const p = await start({ limits: { maxUnauthenticatedPerSource: 3 } });
    const socks = [await dial(p), await dial(p), await dial(p)];
    expect(await closedWithin(await dial(p), 1500)).toBe(true);
    socks[0]!.destroy();
    await Bun.sleep(100);
    const again = await dial(p);
    expect(await closedWithin(again, 300)).toBe(false);
    for (const s of [...socks, again]) s.destroy();
  });

  test("the unauthenticated cap holds over all sources; authenticated tunnels do not count against it, nor it against them", async () => {
    const p = await start({ limits: { maxUnauthenticated: 2, maxUnauthenticatedPerSource: 50 } });
    const { cred } = newAttempt();
    // An authenticated tunnel, held open.
    const tunnelSock = await dial(p);
    tunnelSock.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: ${basic(cred.username, cred.password)}\r\n\r\n`,
    );
    await new Promise<void>((r) => tunnelSock.once("data", () => r()));
    expect(p.stats().authenticated).toBe(1);
    expect(p.stats().unauthenticated).toBe(0);
    // Two idle unauthenticated connections fill the cap; the third is refused.
    const idle = [await dial(p), await dial(p)];
    expect(await closedWithin(await dial(p), 1500)).toBe(true);
    expect(p.stats().unauthenticated).toBe(2);
    // A client with a valid credential is refused only because the unauthenticated cap is full,
    // and goes through again as soon as a slot is free: the tunnel above is untouched.
    idle[0]!.destroy();
    await Bun.sleep(100);
    const ok = await connectOnce(p, basic(cred.username, cred.password));
    expect(ok.head.startsWith("HTTP/1.1 200")).toBe(true);
    expect(tunnelSock.destroyed).toBe(false);
    for (const s of [...idle, tunnelSock]) s.destroy();
  });

  test("the total of open connections is capped", async () => {
    const p = await start({ limits: { maxConnections: 2, maxUnauthenticatedPerSource: 50 } });
    const socks = [await dial(p), await dial(p)];
    expect(await closedWithin(await dial(p), 1500)).toBe(true);
    for (const s of socks) s.destroy();
  });

  test("a failed authentication is answered later each time, for that source and username only", async () => {
    const p = await start({
      limits: { authFailureBaseDelayMs: 120, authFailureMaxDelayMs: 1000 },
    });
    const bad = (user: string): string => basic(user, "wrong");
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await connectOnce(p, bad("alice"));
      expect(r.head.startsWith("HTTP/1.1 407")).toBe(true);
      times.push(r.ms);
    }
    // 120, 240, 480 ms: each later than the one before.
    expect(times[0]!).toBeGreaterThanOrEqual(100);
    expect(times[1]!).toBeGreaterThan(times[0]!);
    expect(times[2]!).toBeGreaterThan(times[1]!);
    // Another username from the same source starts again from the base delay.
    const other = await connectOnce(p, bad("bob"));
    expect(other.ms).toBeLessThan(times[2]!);
  });

  test("a valid credential is never delayed or refused because its source has failed many times", async () => {
    const p = await start({
      limits: { authFailureBaseDelayMs: 200, authFailureMaxDelayMs: 2000 },
    });
    const { cred } = newAttempt();
    // The same address (a shared egress address) fails a lot, as another tenant's job would.
    await Promise.all(
      Array.from({ length: 6 }, () => connectOnce(p, basic("someone-else", "guess"))),
    );
    const t0 = Date.now();
    const ok = await connectOnce(p, basic(cred.username, cred.password));
    expect(ok.head.startsWith("HTTP/1.1 200")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(150);
  });

  test("the CONNECT head has an absolute deadline: a client that drips one byte at a time runs out", async () => {
    const p = await start({ limits: { headDeadlineMs: 700 } });
    const s = await dial(p);
    const t0 = Date.now();
    const dripper = setInterval(() => s.write("C"), 150);
    const closed = await closedWithin(s, 3000);
    clearInterval(dripper);
    expect(closed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
    // An idle client gets no longer than that either.
    const quiet = await dial(p);
    expect(await closedWithin(quiet, 2000)).toBe(true);
  });

  test("source keys: IPv6 by /64, IPv4-mapped as IPv4, IPv4 as is", () => {
    expect(sourceKey("203.0.113.9")).toBe("203.0.113.9");
    expect(sourceKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(sourceKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(sourceKey("2001:db8:1:2::1"));
    expect(sourceKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:db8:1:3::1")).not.toBe(sourceKey("2001:db8:1:2::1"));
    expect(sourceKey("2001:DB8::5")).toBe(sourceKey("2001:db8:0:0:1::5"));
    expect(sourceKey(undefined)).toBe("unknown");
  });

  test("the per-source books are pruned: nothing is kept for a source that went away", async () => {
    const p = await start({
      limits: { authFailureWindowMs: 60, pruneMs: 40, authFailureBaseDelayMs: 1 },
    });
    await connectOnce(p, basic("alice", "wrong"));
    await connectOnce(p, basic("bob", "wrong"));
    expect(p.stats().tracked).toBeGreaterThan(0);
    // (the proxy reads time from the test clock)
    clock += 1000;
    await Bun.sleep(300);
    expect(p.stats().tracked).toBe(0);
  });
});

describe("publish rules through the proxy", () => {
  const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
  const put = (path: string, body: string, host = HOST): string =>
    `PUT ${path} HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const tgz = Buffer.from("approved tarball");
  const doc = (bytes: Buffer): string =>
    JSON.stringify({
      name: "@acme/web",
      versions: {
        "1.0.0": {
          dist: { integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
        },
      },
      _attachments: { "a.tgz": { data: bytes.toString("base64") } },
    });
  const npmRules = (): Rule[] => [
    {
      id: "npm-pkg",
      host: HOST,
      methods: ["GET", "PUT"],
      pathPrefix: "/@acme%2Fweb",
      npmPackage: "@acme/web",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
      secret: "NPM_TOKEN",
      bodyCheck: { type: "npm-publish", digests: [sha(tgz)] },
    },
  ];

  test("the approved tarball is published under the approved package, with the token", async () => {
    const { cred } = newAttempt(npmRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    const r = await t.request(put("/@acme%2Fweb", doc(tgz)));
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://${HOST}/@acme%2Fweb`);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    t.close();
  });

  test("other bytes, another package path, or a sub-path are refused and never sent", async () => {
    const { cred } = newAttempt(npmRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(put("/@acme%2Fweb", doc(Buffer.from("evil"))))).status).toBe(403);
    const t2 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t2.request(put("/@acme%2Fother", doc(tgz)))).status).toBe(403);
    const t3 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t3.request(put("/@acme%2Fweb/-rev/1", doc(tgz)))).status).toBe(403);
    expect(seen).toHaveLength(0);
    const e = events.find((x) => x.reason === "body_digest_not_approved");
    expect(e).toBeDefined();
    expect(e!.detail).toContain(sha(Buffer.from("evil")));
    expect(events.some((x) => x.kind === "inject")).toBe(false);
  });

  test("a GET of the package needs no body check", async () => {
    const { cred } = newAttempt(npmRules());
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/@acme%2Fweb"))).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test("a rule without npmPackage still refuses an encoded slash", async () => {
    const { cred } = newAttempt(rules({ pathPrefix: "/v1/" }));
    const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await t.request(get("/v1/@acme%2Fweb"))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test("a release may be created only as a draft", async () => {
    const r: Rule[] = [
      {
        id: "gh-create",
        host: HOST,
        methods: ["POST"],
        pathPrefix: "/repos/acme/web/releases",
        pathExact: true,
        inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
        secret: "GH",
        bodyCheck: { type: "json", field: "draft", equals: true },
      },
    ];
    const { cred } = newAttempt(r);
    const post = (body: string): string =>
      `POST /repos/acme/web/releases HTTP/1.1\r\nHost: ${HOST}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const a = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await a.request(post('{"tag_name":"v1","draft":true}'))).status).toBe(200);
    const b = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
    expect((await b.request(post('{"tag_name":"v1","draft":false}'))).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  describe("an OCI registry's token exchange", () => {
    const BEARER = "bearer_token_abcdef0123456789";
    const ociRules = (over: Partial<Rule> = {}): Rule[] => [
      {
        id: "oci",
        host: HOST,
        methods: ["GET", "HEAD", "PUT", "POST", "PATCH"],
        pathPrefix: "/v2/acme/web",
        inject: { type: "oci-bearer", username: "bot", scope: "repository:acme/web:push,pull" },
        secret: "REGISTRY_TOKEN",
        ...over,
      },
    ];
    let realm = `https://${HOST}/token`;
    beforeEach(() => {
      realm = `https://${HOST}/token`;
      handler = (s) => {
        const u = new URL(s.url);
        if (u.pathname === "/v2/")
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": `Bearer realm="${realm}",service="reg"` },
          });
        if (u.pathname === "/token") return Response.json({ token: BEARER, expires_in: 300 });
        return new Response("ok");
      };
    });

    test("the proxy answers the challenge and the job's request carries only the bearer", async () => {
      const { cred } = newAttempt(ociRules());
      const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      const r = await t.request(get("/v2/acme/web/blobs/sha256:abc"));
      expect(r.status).toBe(200);
      const exchange = seen.find((s) => new URL(s.url).pathname === "/token")!;
      const q = new URL(exchange.url).searchParams;
      expect(q.get("scope")).toBe("repository:acme/web:push,pull");
      expect(q.get("service")).toBe("reg");
      expect(exchange.headers.get("authorization")).toBe(basic("bot", SECRET));
      const real = seen.find((s) => new URL(s.url).pathname.startsWith("/v2/acme"))!;
      expect(real.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
      // the token is reused for the next request
      await t.request(get("/v2/acme/web/blobs/sha256:def"));
      expect(seen.filter((s) => new URL(s.url).pathname === "/token")).toHaveLength(1);
      t.close();
    });

    test("a realm on another host or over http is refused, and the credential goes nowhere", async () => {
      for (const bad of ["https://evil.example.test/token", `http://${HOST}/token`]) {
        realm = bad;
        const { cred } = newAttempt(ociRules());
        const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
        seen = [];
        expect((await t.request(get("/v2/acme/web/blobs/sha256:abc"))).status).toBe(502);
        expect(seen.every((s) => !s.headers.get("authorization"))).toBe(true);
        expect(reasons()).toContain("oci_token_failed");
      }
    });

    test("a realm host the rule names is allowed", async () => {
      realm = "https://auth.example.test/token";
      const { cred } = newAttempt(
        ociRules({
          inject: {
            type: "oci-bearer",
            username: "bot",
            scope: "repository:acme/web:pull",
            realmHost: "auth.example.test",
          },
        }),
      );
      const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      expect((await t.request(get("/v2/acme/web/blobs/sha256:abc"))).status).toBe(200);
    });

    test("another repository is out of the rule, and a manifest is pinned by digest", async () => {
      const manifest = '{"schemaVersion":2}';
      const { cred } = newAttempt([
        ...ociRules({ methods: ["GET", "HEAD"] }),
        ...ociRules({
          id: "oci-manifest",
          methods: ["PUT"],
          pathPrefix: "/v2/acme/web/manifests/v1.0.0",
          pathExact: true,
          bodyCheck: { type: "sha256", digests: [sha(manifest)] },
        }),
      ]);
      const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      expect((await t.request(get("/v2/other/repo/blobs/sha256:abc"))).status).toBe(403);
      const t2 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      expect((await t2.request(put("/v2/acme/web/manifests/v1.0.0", manifest))).status).toBe(200);
      const t3 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      expect(
        (await t3.request(put("/v2/acme/web/manifests/v1.0.0", '{"schemaVersion":3}'))).status,
      ).toBe(403);
      const t4 = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      expect((await t4.request(put("/v2/acme/web/manifests/latest", manifest))).status).toBe(403);
    });

    test("neither the credential nor the bearer comes back in a response", async () => {
      handler = (s) =>
        new URL(s.url).pathname === "/v2/"
          ? new Response("", {
              status: 401,
              headers: { "www-authenticate": `Bearer realm="${realm}"` },
            })
          : new URL(s.url).pathname === "/token"
            ? Response.json({ token: BEARER })
            : new Response(`echo ${s.headers.get("authorization")}`);
      const { cred } = newAttempt(ociRules());
      const t = await tunnel({ auth: basic(cred.username, cred.password), ca: cred.caPem });
      const r = await t.request(get("/v2/acme/web/blobs/sha256:abc"));
      expect(r.body).not.toContain(BEARER);
      expect(r.body).not.toContain(SECRET);
    });
  });
});
