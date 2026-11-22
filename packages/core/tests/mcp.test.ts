import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJob, createAttempt, type Db, transitionJob, upsertStep } from "../src/db";
import { resultText, UNTRUSTED_NOTICE } from "../src/mcp/envelope";
import { readTokenFile, runMcpStdio } from "../src/mcp/stdio";
import { registry } from "../src/ops";
import { compileSafeRegex, SafeRegexError } from "../src/ops/safe-regex";
import { startServer } from "../src/server";
import { addLog, mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let token: string;
let server: ReturnType<typeof startServer>;
let url: URL;

beforeAll(async () => {
  ({ db, a, b } = await seedWorld());
  token = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
  server = startServer({ port: 0, host: "127.0.0.1", db });
  url = new URL(`http://127.0.0.1:${server.port}/mcp`);
});
afterAll(async () => {
  await server.stop(true);
  db.close();
});

async function httpClient(bearer: string | null = token): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} },
    }),
  );
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) };
}

/** A line-delimited JSON-RPC session over injected streams: what `longshore mcp` speaks. */
async function stdioSession(bearer: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buf = "";
  const waiting = new Map<number, (m: any) => void>();
  stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  const handle = await runMcpStdio({ env: { registry, db }, token: bearer, stdin, stdout });
  let id = 0;
  const rpc = (method: string, params: unknown = {}): Promise<any> =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { rpc, lines, close: () => handle.close() };
}

const expectedTools = () =>
  registry
    .tokenOps()
    .map((o) => o.name)
    .toSorted();

describe("transports", () => {
  test("http: tool list is the registry minus signature ops", async () => {
    const client = await httpClient();
    const names = (await client.listTools()).tools.map((t) => t.name).toSorted();
    expect(names).toEqual(expectedTools());
    expect(names).toContain("failure_digest");
    await client.close();
  });

  test("stdio: tool list is the registry minus signature ops, and stdout carries only protocol", async () => {
    const s = await stdioSession(token);
    const res = await s.rpc("tools/list");
    expect(res.result.tools.map((t: { name: string }) => t.name).toSorted()).toEqual(
      expectedTools(),
    );
    // Every stdout line is a JSON-RPC message.
    for (const l of s.lines) expect(JSON.parse(l).jsonrpc).toBe("2.0");
    await s.close();
  });

  test("a bad token fails on both transports, and a missing one on http", async () => {
    await expect(httpClient("lsb_not_a_real_token")).rejects.toThrow();
    await expect(httpClient(null)).rejects.toThrow();
    await expect(runMcpStdio({ env: { registry, db }, token: "nope" })).rejects.toThrow();
    // Plain HTTP shape: 401 with a challenge, GET refused.
    const bad = await fetch(url, { method: "POST", body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("Bearer");
    const get = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });

  test("the token is read from the Authorization header only", async () => {
    const res = await fetch(`${url}?token=${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("a revoked token stops working mid-session (every call re-authenticates)", async () => {
    const t = await mintToken(db, { orgId: a.orgId }, "reader");
    const client = await httpClient(t.secret);
    expect((await call(client, "whoami")).isError).toBe(false);
    const { revokeApiToken } = await import("../src/db");
    await revokeApiToken(db, { orgId: a.orgId }, t.id, Date.now());
    const after = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${t.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
    await client.close();
  });
});

describe("tools", () => {
  test("results are wrapped as untrusted where the op carries log or forge text", async () => {
    await addLog(db, a, "hello from the job\n");
    const client = await httpClient();
    const log = await call(client, "job_log", { job_id: a.jobId });
    expect(log.isError).toBe(false);
    expect(log.body).toMatchObject({
      untrusted: true,
      source: "job_log",
      notice: UNTRUSTED_NOTICE,
    });
    expect(log.body.content.text).toContain("hello from the job");
    // A trusted op is not wrapped.
    expect(JSON.parse(resultText("x", { a: 1 }, false))).toEqual({ a: 1 });
    await client.close();
  });

  test("a call for another org fails, by slug and by id", async () => {
    const client = await httpClient();
    const bySlug = await call(client, "list_runs", { org: b.slug });
    expect(bySlug.isError).toBe(true);
    expect(bySlug.body.error.code).toBe("not_found");
    const byId = await call(client, "get_run", { run_id: b.runId });
    expect(byId.isError).toBe(true);
    expect(byId.body.error.code).toBe("not_found");
    const log = await call(client, "job_log", { job_id: b.jobId });
    expect(log.isError).toBe(true);
    await client.close();
  });

  test("unknown tools and invalid input are errors, not crashes", async () => {
    const client = await httpClient();
    await expect(client.callTool({ name: "approve_release", arguments: {} })).rejects.toThrow();
    const bad = await call(client, "job_log", { job_id: a.jobId, lines: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.code).toBe("invalid_input");
    await client.close();
  });
});

describe("resources", () => {
  test("templates, a run, and a job log with an encoded matrix key", async () => {
    const job = (await createJob(db, a.scope, {
      runId: a.runId,
      jobKey: "test[0]",
      name: "test (0)",
    }))!;
    const att = (await createAttempt(db, a.scope, { jobId: job.id, provider: "test" }))!;
    const { appendLog } = await import("../src/db");
    await appendLog(db, a.scope, att.id, 0, new TextEncoder().encode("matrix leg output\n"));

    const client = await httpClient();
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate,
    );
    expect(templates).toEqual(["longshore://runs/{id}", "longshore://runs/{id}/jobs/{key}/log"]);
    const run = await client.readResource({ uri: `longshore://runs/${a.runId}` });
    const runBody = JSON.parse((run.contents[0] as { text: string }).text);
    expect(runBody).toMatchObject({ untrusted: true, source: "get_run" });
    expect(runBody.content.jobs.map((j: { job_key: string }) => j.job_key)).toContain("test[0]");

    const log = await client.readResource({
      uri: `longshore://runs/${a.runId}/jobs/${encodeURIComponent("test[0]")}/log`,
    });
    const logBody = JSON.parse((log.contents[0] as { text: string }).text);
    expect(logBody).toMatchObject({ untrusted: true, source: "job_log" });
    expect(logBody.content.text).toContain("matrix leg output");

    await expect(
      client.readResource({ uri: `longshore://runs/${a.runId}/jobs/nope/log` }),
    ).rejects.toThrow();
    // Another org's run is not readable, and an unknown URI is refused.
    await expect(client.readResource({ uri: `longshore://runs/${b.runId}` })).rejects.toThrow();
    await expect(client.readResource({ uri: "longshore://other/x" })).rejects.toThrow();
    await client.close();
  });
});

describe("job_log grep", () => {
  const LOG =
    Array.from({ length: 50 }, (_, i) =>
      i === 10 || i === 11 || i === 40 ? `line ${i} ERROR boom` : `line ${i} ok`,
    ).join("\n") + "\n";
  let jobId: string;
  beforeAll(async () => {
    const job = (await createJob(db, a.scope, { runId: a.runId, jobKey: "grepjob", name: "g" }))!;
    const att = (await createAttempt(db, a.scope, { jobId: job.id, provider: "test" }))!;
    const { appendLog } = await import("../src/db");
    await appendLog(db, a.scope, att.id, 0, new TextEncoder().encode(LOG));
    jobId = job.id;
  });

  test("literal with context, groups separated, byte offsets", async () => {
    const client = await httpClient();
    const r = await call(client, "job_log", {
      job_id: jobId,
      mode: "grep",
      pattern: "ERROR",
      context: 1,
    });
    const out = r.body.content;
    expect(out.matches).toBe(3);
    expect(out.text).toContain(":line 10 ERROR boom");
    expect(out.text).toContain("-line 9 ok");
    expect(out.text).toContain("-line 12 ok");
    expect(out.text.split("--\n")).toHaveLength(2); // lines 9-12 and 39-41
    expect(/^\d+-line 9 ok\n\d+:line 10 ERROR boom\n/.test(out.text)).toBe(true);
    expect(out.next_offset).toBeNull();
    await client.close();
  });

  test("max_matches stops early and next_offset continues without repeats", async () => {
    const client = await httpClient();
    const one = (
      await call(client, "job_log", {
        job_id: jobId,
        mode: "grep",
        pattern: "ERROR",
        context: 0,
        max_matches: 1,
      })
    ).body.content;
    expect(one.matches).toBe(1);
    expect(one.next_offset).not.toBeNull();
    const rest = (
      await call(client, "job_log", {
        job_id: jobId,
        mode: "grep",
        pattern: "ERROR",
        context: 0,
        offset: one.next_offset,
      })
    ).body.content;
    expect(rest.matches).toBe(2);
    expect(rest.text).not.toContain("line 10 ");
    await client.close();
  });

  test("regex subset, ignore_case, and refused syntax", async () => {
    const client = await httpClient();
    const r = (
      await call(client, "job_log", {
        job_id: jobId,
        mode: "grep",
        pattern: "^line (10|40) error",
        regex: true,
        ignore_case: true,
        context: 0,
      })
    ).body.content;
    expect(r.matches).toBe(2);
    for (const pattern of ["(?=x)", "(a)\\1", "a{1000}"]) {
      const bad = await call(client, "job_log", {
        job_id: jobId,
        mode: "grep",
        pattern,
        regex: true,
      });
      expect(bad.isError).toBe(true);
      expect(bad.body.error.code).toBe("invalid_input");
    }
    const none = await call(client, "job_log", { job_id: jobId, mode: "grep" });
    expect(none.body.error.code).toBe("invalid_input");
    await client.close();
  });

  test("works over REST with flat query parameters", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/jobs/${jobId}/log?mode=grep&pattern=ERROR&context=0&max_matches=2`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches: number }).matches).toBe(2);
  });

  test("a catastrophic pattern finishes at once (linear-time matcher)", async () => {
    const client = await httpClient();
    const started = Date.now();
    const r = await call(client, "job_log", {
      job_id: jobId,
      mode: "grep",
      pattern: "(a+)+$",
      regex: true,
    });
    expect(r.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    await client.close();
  });
});

describe("safe regex", () => {
  test("matches like a regex for the supported subset", () => {
    const m = (p: string, s: string, i = false) => compileSafeRegex(p, { ignoreCase: i })(s);
    expect(m("err(or)?", "an error")).toBe(true);
    expect(m("^ab+c$", "abbbc")).toBe(true);
    expect(m("^ab+c$", "xabc")).toBe(false);
    expect(m("a{2,3}b", "caab")).toBe(true);
    expect(m("a{2,3}b", "cab")).toBe(false);
    expect(m("\\bfoo\\b", "a foo b")).toBe(true);
    expect(m("\\bfoo\\b", "afoob")).toBe(false);
    expect(m("[0-9]+ passed|FAIL", "12 passed")).toBe(true);
    expect(m("ERROR", "an error", true)).toBe(true);
    expect(m("[^a-c]x", "dx")).toBe(true);
    expect(m("(?:ab)*c", "ababc")).toBe(true);
  });

  test("hostile patterns are linear or refused", () => {
    const t = Date.now();
    expect(compileSafeRegex("(a+)+$")(`${"a".repeat(20_000)}!`)).toBe(false);
    expect(compileSafeRegex("(.*)*(.*)*(.*)*x")("y".repeat(5000))).toBe(false);
    expect(Date.now() - t).toBeLessThan(3000);
    for (const p of [
      "(?=a)",
      "(?<n>a)",
      "(a)\\1",
      "a{101}",
      "((a{100}){100}){100}",
      "*a",
      "(a",
      "a)",
      "",
    ]) {
      expect(() => compileSafeRegex(p)).toThrow(SafeRegexError);
    }
    expect(() => compileSafeRegex("a".repeat(201))).toThrow(SafeRegexError);
  });
});

describe("failure_digest", () => {
  const E = "\u001b[";
  async function failedJob(key: string, body: string, steps: [string, number, string | null][]) {
    const job = (await createJob(db, a.scope, { runId: a.runId, jobKey: key, name: key }))!;
    const att = (await createAttempt(db, a.scope, { jobId: job.id, provider: "test" }))!;
    const { appendLog } = await import("../src/db");
    await appendLog(db, a.scope, att.id, 0, new TextEncoder().encode(body));
    for (const [i, [name, off, result]] of steps.entries()) {
      await upsertStep(db, a.scope, {
        attemptId: att.id,
        stepKey: `s${i}`,
        stage: "main",
        index: i,
        name,
        result: result as never,
        startedAt: null,
        finishedAt: null,
        logOffset: off,
      });
    }
    await transitionJob(db, a.scope, job.id, "running");
    await transitionJob(db, a.scope, job.id, "failure", { exitCode: 1 });
    return job.id;
  }

  test("annotation first, redacted, capped, with the recorded failing step", async () => {
    const secret = `ghp_${"a1b2".repeat(9)}`;
    const setup = "setting up\n";
    const body =
      `${setup}${E}1mRun tests${E}0m\n` +
      "noise before\nerror: not an annotation, should lose to the annotation\n" +
      `::error file=src/a.ts,line=3::assertion failed with ${secret}\n` +
      "::error file=src/b.ts,line=9::second one\n" +
      `${"x".repeat(100)}\n`.repeat(100) +
      "after the failing step\n";
    const stepEnd = Buffer.byteLength(body) - Buffer.byteLength("after the failing step\n");
    const id = await failedJob("digest-a", body, [
      ["Set up job", 0, "success"],
      ["Run tests", Buffer.byteLength(setup), "failure"],
      ["Post", stepEnd, "success"],
    ]);
    const client = await httpClient();
    const r = (await call(client, "failure_digest", { job_id: id })).body;
    expect(r.untrusted).toBe(true);
    const d = r.content.digests[0];
    expect(d.step).toMatchObject({ name: "Run tests", stage: "main", result: "failure" });
    expect(d.basis).toBe("annotation");
    expect(d.excerpt).toContain("::error file=src/a.ts,line=3::assertion failed");
    expect(d.excerpt).toContain("second one");
    expect(d.excerpt).not.toContain(secret);
    expect(d.excerpt).not.toContain("after the failing step");
    expect(Buffer.byteLength(d.excerpt)).toBeLessThanOrEqual(2048);
    await client.close();
  });

  test("error pattern near the step's end when there is no annotation; ANSI stripped", async () => {
    const body =
      `${E}1mBuild${E}0m\n` +
      `${"compiling...\n".repeat(300)}` +
      `${E}31merror${E}0m: cannot find module 'left-pad'\n  at build.ts:12\n` +
      "done with warnings\n";
    const id = await failedJob("digest-b", body, [["Build", 0, "failure"]]);
    const client = await httpClient();
    const d = (await call(client, "failure_digest", { job_id: id })).body.content.digests[0];
    expect(d.basis).toBe("error_pattern");
    expect(d.excerpt).toContain("error: cannot find module 'left-pad'");
    expect(d.excerpt).not.toContain("\u001b");
    expect(d.excerpt.length).toBeLessThan(600);
    await client.close();
  });

  test("by run: failed jobs only; exactly one of run_id and job_id", async () => {
    const client = await httpClient();
    const r = (await call(client, "failure_digest", { run_id: a.runId })).body.content;
    expect(r.failing_jobs).toBe(2);
    expect(r.digests.map((x: { job_key: string }) => x.job_key).toSorted()).toEqual([
      "digest-a",
      "digest-b",
    ]);
    const both = await call(client, "failure_digest", { run_id: a.runId, job_id: a.jobId });
    expect(both.body.error.code).toBe("invalid_input");
    const neither = await call(client, "failure_digest", {});
    expect(neither.body.error.code).toBe("invalid_input");
    const other = await call(client, "failure_digest", { job_id: b.jobId });
    expect(other.body.error.code).toBe("not_found");
    await client.close();
  });
});

describe("token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-mcp-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("must be private and non-empty", () => {
    const f = join(dir, "t");
    writeFileSync(f, "abc\n");
    chmodSync(f, 0o644);
    expect(() => readTokenFile(f)).toThrow("readable by others");
    chmodSync(f, 0o600);
    expect(readTokenFile(f)).toBe("abc");
    writeFileSync(f, "\n");
    expect(() => readTokenFile(f)).toThrow("empty");
  });
});
