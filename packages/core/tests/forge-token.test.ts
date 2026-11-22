import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanError, tarDirectory } from "@longshore/act-runner";
import type { SafeFetch } from "@longshore/net";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import { InfraError } from "@longshore/provider-sdk";
import { bindRepo, type Db, getVerdict, listRepos } from "../src/db";
import { createForgeToken } from "../src/pins/forge-token";
import { cachedReachability, cachedResolver } from "../src/pins/verdict-cache";
import { createActRunner } from "../src/scheduler";
import type { AttemptContext } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const SHA = (c: string) => c.repeat(40);
const tmp = mkdtempSync(join(tmpdir(), "ls-forge-token-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Db;
let a: Tenant;
beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

function tokenFile(contents: string): string {
  const f = join(tmp, `tok-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, contents);
  chmodSync(f, 0o600);
  return f;
}

describe("which credential the worker uses", () => {
  const run = (repo: string | null, local = false) => ({ repo, local });
  const ctx = (r: ReturnType<typeof run>) => ({ run: r, scope: a.scope });

  test("the poll token for a repo the poller watches; then an App token read-only; then the env", async () => {
    const minted: unknown[] = [];
    const auth = {
      async mint(installationId: string, scope: unknown) {
        minted.push({ installationId, scope });
        return { token: "app-token-for-checks" };
      },
    };
    await bindRepo(db, a.scope, {
      forge: "github",
      owner: "acme",
      repo: "app",
      installationId: "55",
    });
    const get = createForgeToken({
      db,
      poll: { tokenFile: tokenFile("poll-token-value\n"), repos: [{ repo: "Acme/Web" }] },
      auth,
      envToken: "env-token-value",
    });
    // Watched by the poller (any case): its token, no mint.
    expect(await get(ctx(run("acme/web")))).toBe("poll-token-value");
    expect(minted).toHaveLength(0);
    // Not watched, bound through the App: an installation token for that one repo, read only.
    expect(await get(ctx(run("acme/app")))).toBe("app-token-for-checks");
    expect(minted).toEqual([
      { installationId: "55", scope: { repositories: ["app"], permissions: { contents: "read" } } },
    ]);
    // Neither: the env token. A local run uses it too and never a poll or App token.
    expect(await get(ctx(run("other/thing")))).toBe("env-token-value");
    expect(await get(ctx(run("acme/web", true)))).toBe("env-token-value");
    expect(await get(ctx(run(null)))).toBe("env-token-value");
  });

  test("with nothing it is unauthenticated, and says so once", async () => {
    const logs: string[] = [];
    const get = createForgeToken({ db, log: (m) => logs.push(m) });
    expect(await get(ctx(run("acme/web")))).toBeUndefined();
    expect(await get(ctx(run("acme/web")))).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("unauthenticated");
  });

  test("a failing mint or an unreadable token file falls back instead of failing the job", async () => {
    await bindRepo(db, a.scope, {
      forge: "github",
      owner: "acme",
      repo: "app",
      installationId: "55",
    });
    const logs: string[] = [];
    const get = createForgeToken({
      db,
      poll: { tokenFile: join(tmp, "missing"), repos: [{ repo: "acme/web" }] },
      auth: {
        async mint() {
          throw new Error("HTTP 503");
        },
      },
      envToken: "env-token-value",
      log: (m) => logs.push(m),
    });
    expect(await get(ctx(run("acme/web")))).toBe("env-token-value");
    expect(await get(ctx(run("acme/app")))).toBe("env-token-value");
    expect(logs.join("\n")).not.toContain("env-token-value");
  });
});

describe("verdicts kept in the database", () => {
  test("a resolution is remembered across restarts until it ages out; shas and failures are not stored", async () => {
    let now = 1_000_000;
    let calls = 0;
    const base = async (_o: string, _r: string, ref: string) => {
      calls++;
      if (ref === "boom") throw new InfraError("GitHub is down");
      return SHA("1");
    };
    const make = () => cachedResolver({ db, scope: a.scope, base, now: () => now });
    expect(await make()("acme", "tool", "v1")).toBe(SHA("1"));
    // A restart: a new resolver, the same database. No second call.
    expect(await make()("acme", "tool", "v1")).toBe(SHA("1"));
    expect(calls).toBe(1);
    // Past the TTL it asks again.
    now += 6 * 60_000;
    await make()("acme", "tool", "v1");
    expect(calls).toBe(2);
    // A full sha is never resolved or stored; a failure is not remembered.
    await make()("acme", "tool", SHA("2"));
    await expect(make()("acme", "tool", "boom")).rejects.toBeInstanceOf(InfraError);
    await expect(make()("acme", "tool", "boom")).rejects.toBeInstanceOf(InfraError);
    expect(calls).toBe(5);
    expect(
      await getVerdict(db, a.scope, { kind: "resolve", repo: "acme/tool", ref: "boom" }, 1e12, now),
    ).toBeUndefined();
  });

  test("reachability: yes lasts a day, no only ten minutes, and it survives a restart", async () => {
    let now = 5_000_000;
    let calls = 0;
    let answer = true;
    const base = async () => (calls++, answer);
    const make = () => cachedReachability({ db, scope: a.scope, base, now: () => now });
    expect(await make()("acme", "tool", SHA("1"))).toBe(true);
    expect(await make()("acme", "tool", SHA("1"))).toBe(true);
    expect(calls).toBe(1);
    now += 23 * 3_600_000;
    await make()("acme", "tool", SHA("1"));
    expect(calls).toBe(1);
    now += 2 * 3_600_000;
    await make()("acme", "tool", SHA("1"));
    expect(calls).toBe(2);

    answer = false;
    expect(await make()("acme", "tool", SHA("f"))).toBe(false);
    expect(await make()("acme", "tool", SHA("f"))).toBe(false);
    expect(calls).toBe(3);
    // Ten minutes on, a negative verdict is checked again, so a fixed situation is noticed.
    now += 11 * 60_000;
    answer = true;
    expect(await make()("acme", "tool", SHA("f"))).toBe(true);
    expect(calls).toBe(4);
  });

  test("verdicts are per project and per repo", async () => {
    const base = async () => true;
    await cachedReachability({ db, scope: a.scope, base })("acme", "tool", SHA("1"));
    expect(
      await getVerdict(db, a.scope, { kind: "reach", repo: "acme/tool", sha: SHA("1") }, 1e12),
    ).toBeDefined();
    expect(
      await getVerdict(db, a.scope, { kind: "reach", repo: "acme/other", sha: SHA("1") }, 1e12),
    ).toBeUndefined();
  });
});

describe("the worker's action resolution", () => {
  const world = new FakeWorld({ hostPaths: [tmp] });
  afterAll(() => world.dispose());
  const WORKFLOW = `name: ci
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/tool@v1
`;
  async function nodeTarball(): Promise<Uint8Array> {
    const top = "x-y-abc123";
    const d = mkdtempSync(join(tmp, "t-"));
    mkdirSync(join(d, top), { recursive: true });
    writeFileSync(
      join(d, top, "action.yml"),
      "name: n\nruns:\n  using: node20\n  main: index.js\n",
    );
    return tarDirectory(d, [top]);
  }

  /** A GitHub API that records the Authorization of every call and can rate-limit. */
  function github(
    over: { limit?: { path: RegExp; times: number; headers: Record<string, string> } } = {},
  ) {
    const calls: { path: string; auth: string | null }[] = [];
    let limited = 0;
    const impl: SafeFetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
      if (over.limit && over.limit.path.test(url.pathname) && limited < over.limit.times) {
        limited++;
        return new Response("rate limited", { status: 403, headers: over.limit.headers });
      }
      if (url.pathname.endsWith("/commits/v1")) return new Response(SHA("c"));
      if (/\/compare\//.test(url.pathname)) return Response.json({ status: "identical" });
      if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname))
        return Response.json({ default_branch: "main" });
      return new Response("unexpected", { status: 500 });
    };
    return { impl, calls };
  }

  /** Plans the job with the given runner options; the sandbox is made to fail right after. */
  async function plan(opts: Partial<Parameters<typeof createActRunner>[0]>) {
    // The worker needs the project bound to the repo it fetches.
    if (!(await listRepos(db, a.scope)).some((r) => r.owner === "acme" && r.repo === "web")) {
      await bindRepo(db, a.scope, { forge: "github", owner: "acme", repo: "web" });
    }
    const base = world.provider();
    const provider = Object.assign(Object.create(base), {
      create: async () => {
        throw new InfraError("stop after planning");
      },
    });
    const runner = createActRunner({
      db,
      source: {
        checkout: async () => ({
          tarball: new Uint8Array(),
          readFile: (p: string) => (p === ".github/workflows/ci.yml" ? WORKFLOW : undefined),
        }),
      },
      fetchAction: nodeTarball,
      planRoot: join(tmp, "root"),
      ...opts,
    });
    const noop = async () => {};
    return runner({
      attempt: { id: "att1", plan: null },
      job: { id: "job1", jobKey: "a", planned: null },
      run: {
        id: "run1",
        sha: SHA("a"),
        event: "push",
        ref: "refs/heads/main",
        workflowPath: ".github/workflows/ci.yml",
        repo: "acme/web",
        local: false,
        trust: null,
        plan: null,
        approval: null,
      },
      scope: a.scope,
      provider,
      signal: new AbortController().signal,
      store: {
        setExec: noop,
        setPlan: noop,
        reset: noop,
        appendLog: noop,
        recordStep: noop,
        addCut: noop,
      },
    } as unknown as AttemptContext);
  }

  test("resolution and the reachability check use the poll token", async () => {
    const gh = github();
    const forgeToken = createForgeToken({
      db,
      poll: { tokenFile: tokenFile("poll-token-value"), repos: [{ repo: "acme/web" }] },
    });
    await plan({ fetch: gh.impl, forgeToken });
    expect(gh.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of gh.calls) expect(c.auth).toBe("Bearer poll-token-value");
  });

  test("with no credential the calls are unauthenticated (what the bug was)", async () => {
    const gh = github();
    await plan({ fetch: gh.impl });
    expect(gh.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of gh.calls) expect(c.auth).toBeNull();
  });

  test("a restart re-verifies nothing: verdicts come from the database", async () => {
    const first = github();
    await plan({ fetch: first.impl });
    expect(first.calls.length).toBeGreaterThanOrEqual(3);
    // A new runner (a new process) with the same database makes no GitHub call at all.
    const second = github();
    await plan({ fetch: second.impl });
    expect(second.calls).toHaveLength(0);
  });

  test("a rate limit backs off as GitHub asks, then succeeds", async () => {
    const waits: number[] = [];
    const gh = github({
      limit: { path: /\/compare\//, times: 2, headers: { "retry-after": "3" } },
    });
    const out = await plan({
      fetch: gh.impl,
      backoff: { sleep: async (ms) => void waits.push(ms) },
    });
    // It got past planning (the sandbox then refuses, which is the stop we asked for).
    expect(out.reason).toContain("stop after planning");
    expect(waits).toEqual([4000, 4000]);
  });

  test("a primary limit waits for the reset; one that outlasts the budget is an infra error saying when", async () => {
    const now = 2_000_000_000_000;
    const reset = String(now / 1000 + 30);
    const waits: number[] = [];
    const short = github({
      limit: {
        path: /\/commits\/v1$/,
        times: 1,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      },
    });
    const ok = await plan({
      fetch: short.impl,
      now: () => now,
      backoff: { now: () => now, sleep: async (ms) => void waits.push(ms) },
    });
    expect(ok.reason).toContain("stop after planning");
    expect(waits).toEqual([31_000]);

    const long = github({
      limit: {
        path: /\/commits\/v1$/,
        times: 99,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 3600) },
      },
    });
    const err = await plan({
      fetch: long.impl,
      // The first run's verdicts are not reused here: this one must ask GitHub.
      verdictTtl: { resolveMs: 0, reachYesMs: 0, reachNoMs: 0 },
      now: () => now,
      backoff: { now: () => now, sleep: async () => {}, budgetMs: 120_000 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(String(err.message)).toContain("rate limited");
    expect(String(err.message)).toContain("wait budget");
    // A PlanError would have been a deterministic failure; a rate limit is not one.
    expect(err).not.toBeInstanceOf(PlanError);
  });
});
