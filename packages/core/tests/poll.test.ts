import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Db,
  ensureLocalTenant,
  getJob,
  listAttempts,
  listJobs,
  listRepos,
  listRuns,
  openDatabase,
  type Scope,
} from "../src/db";
import {
  gatePullRequest,
  GithubClient,
  loadPollConfig,
  type PollConfig,
  Poller,
  pollConfigSchema,
  pollRepo,
  RateLimited,
} from "../src/poll";

let db: Db;
let scope: Required<Scope>;

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
const SHA = (c: string) => c.repeat(40);

type PullStub = {
  number: number;
  title?: string;
  user: string | null;
  headSha: string;
  headRef?: string;
  headRepo: string | null;
  baseRepo?: string;
};

/** A GitHub API stand-in served through fetch. */
function makeGithub(repo = "acme/web") {
  const state = {
    head: { sha: SHA("a"), message: "feat: first", login: "octocat" as string | null },
    pulls: [] as PullStub[],
    files: new Map<string, string>(),
    calls: [] as { path: string; headers: Record<string, string> }[],
    fail: undefined as undefined | { status: number; headers?: Record<string, string> },
  };
  const workflowPath = ".github/workflows/ci.yml";
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    state.calls.push({ path: u.pathname + u.search, headers });
    if (state.fail) {
      return new Response("nope", { status: state.fail.status, headers: state.fail.headers ?? {} });
    }
    const etagged = (body: string, etag: string, type: string): Response => {
      if (headers["if-none-match"] === etag) return new Response(null, { status: 304 });
      return new Response(body, { headers: { etag, "content-type": type } });
    };
    if (u.pathname === `/repos/${repo}/commits/main`) {
      return etagged(
        JSON.stringify({
          sha: state.head.sha,
          commit: { message: state.head.message },
          author: state.head.login === null ? null : { login: state.head.login },
        }),
        `"head-${state.head.sha}"`,
        "application/json",
      );
    }
    if (u.pathname === `/repos/${repo}/pulls`) {
      const body = state.pulls.map((p) => ({
        number: p.number,
        title: p.title ?? `PR ${p.number}`,
        user: p.user === null ? null : { login: p.user },
        head: {
          sha: p.headSha,
          ref: p.headRef ?? "topic",
          repo: p.headRepo === null ? null : { full_name: p.headRepo },
        },
        base: { repo: { full_name: p.baseRepo ?? repo } },
      }));
      return etagged(
        JSON.stringify(body),
        `"pulls-${JSON.stringify(body).length}"`,
        "application/json",
      );
    }
    if (u.pathname === `/repos/${repo}/contents/${workflowPath}`) {
      const sha = u.searchParams.get("ref") ?? "";
      const text = state.files.get(sha) ?? state.files.get("*");
      return text === undefined ? new Response("not found", { status: 404 }) : new Response(text);
    }
    return new Response("unexpected", { status: 500 });
  };
  state.files.set("*", WORKFLOW);
  return { state, fetch: fetchStub };
}

function config(
  over: Partial<PollConfig["repos"][number]> = {},
  top: Partial<PollConfig> = {},
): PollConfig {
  return pollConfigSchema.parse({
    ...top,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        authors: ["octocat", "hubot"],
        ...over,
      },
    ],
  });
}

const clientFor = (gh: ReturnType<typeof makeGithub>, token?: string) =>
  new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com", token });

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

async function poll(gh: ReturnType<typeof makeGithub>, cfg = config(), now = 1_800_000_000_000) {
  return pollRepo({ db, github: clientFor(gh), provider: "docker", now: () => now }, cfg.repos[0]!);
}

test("a new default-branch commit becomes a queued run with its metadata and jobs", async () => {
  const gh = makeGithub();
  const res = await poll(gh);
  expect(res.created).toHaveLength(1);
  const [run] = await listRuns(db, scope);
  expect(run).toMatchObject({
    event: "push",
    ref: "refs/heads/main",
    sha: SHA("a"),
    actor: "octocat",
    commitMessage: "feat: first",
    headBranch: "main",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    prNumber: null,
    status: "queued",
  });
  const jobs = await listJobs(db, scope, run!.id);
  expect(jobs.map((j) => [j.jobKey, JSON.parse(j.needs)])).toEqual([
    ["build", []],
    ["test", ["build"]],
  ]);
  for (const job of jobs) {
    expect((await getJob(db, scope, job.id))?.state).toBe("queued");
    expect((await listAttempts(db, scope, job.id)).map((a) => [a.state, a.provider])).toEqual([
      ["queued", "docker"],
    ]);
  }
  // the project is bound to the repo, so the worker knows what to fetch
  expect((await listRepos(db, scope)).map((r) => `${r.forge}:${r.owner}/${r.repo}`)).toEqual([
    "github:acme/web",
  ]);
});

test("ingest is idempotent per (repo, workflow, event, sha)", async () => {
  const gh = makeGithub();
  await poll(gh);
  await poll(gh);
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(1);
  gh.state.head = { sha: SHA("b"), message: "fix", login: "hubot" };
  await poll(gh);
  expect((await listRuns(db, scope)).map((r) => r.sha)).toEqual([SHA("b"), SHA("a")]);
  // the same sha as a push and as a PR head are different events: both run
  gh.state.pulls = [{ number: 3, user: "octocat", headSha: SHA("b"), headRepo: "acme/web" }];
  await poll(gh);
  const runs = await listRuns(db, scope);
  expect(runs.map((r) => [r.event, r.sha])).toEqual([
    ["pull_request", SHA("b")],
    ["push", SHA("b")],
    ["push", SHA("a")],
  ]);
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(3);
  // a new head sha of the same PR is a new run
  gh.state.pulls = [{ number: 3, user: "octocat", headSha: SHA("c"), headRepo: "acme/web" }];
  await poll(gh);
  expect(await listRuns(db, scope)).toHaveLength(4);
});

test("a same-repo PR by an allowlisted author runs, with its PR metadata", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    {
      number: 17,
      title: "Add feature",
      user: "HubOT",
      headSha: SHA("d"),
      headRef: "feature/x",
      headRepo: "acme/web",
    },
  ];
  const res = await poll(gh);
  expect(res.created).toHaveLength(2); // the push and the PR
  const pr = (await listRuns(db, scope)).find((r) => r.event === "pull_request")!;
  expect(pr).toMatchObject({
    ref: "refs/pull/17/head",
    sha: SHA("d"),
    actor: "HubOT",
    prNumber: 17,
    headBranch: "feature/x",
    commitMessage: "Add feature",
  });
});

test("the PR gate: a fork is never run, whatever else is true", () => {
  const cfg = { repo: "acme/web", prMode: "allowlist" as const, authors: ["octocat"] };
  const ok = { baseRepo: "acme/web", headRepo: "acme/web", author: "octocat" };
  expect(gatePullRequest(cfg, ok).ok).toBe(true);
  expect(gatePullRequest(cfg, { ...ok, author: "OCTOCAT" }).ok).toBe(true); // logins are case-insensitive
  expect(gatePullRequest({ ...cfg, repo: "Acme/Web" }, ok).ok).toBe(true); // so are repo names

  const refused: [string, Parameters<typeof gatePullRequest>[1]][] = [
    ["fork under another owner", { ...ok, headRepo: "octocat/web" }],
    ["fork with the same name elsewhere", { ...ok, headRepo: "evil/web" }],
    ["lookalike name", { ...ok, headRepo: "acme/web2" }],
    ["lookalike owner", { ...ok, headRepo: "acme-x/web" }],
    ["prefix of the name", { ...ok, headRepo: "acme/we" }],
    ["suffix on the owner", { ...ok, headRepo: "acme/web-fork" }],
    ["deleted fork", { ...ok, headRepo: null }],
    ["base is another repo", { ...ok, baseRepo: "acme/other" }],
    ["no author login", { ...ok, author: null }],
    ["author not on the allowlist", { ...ok, author: "mallory" }],
    ["author contains an allowlisted login", { ...ok, author: "octocat-evil" }],
  ];
  for (const [name, pr] of refused) {
    const v = gatePullRequest(cfg, pr);
    expect(v.ok, name).toBe(false);
  }
  // an allowlisted author on a FORK is still refused
  const fork = gatePullRequest(cfg, {
    baseRepo: "acme/web",
    headRepo: "octocat/web",
    author: "octocat",
  });
  expect(fork).toEqual({ ok: false, reason: "head repo is a fork" });
  // and PR mode off refuses everything, even a perfect PR
  expect(gatePullRequest({ ...cfg, prMode: "off" }, ok).ok).toBe(false);
  // an empty allowlist refuses every PR
  expect(gatePullRequest({ ...cfg, authors: [] }, ok).ok).toBe(false);
});

test("through the poller: forks and non-allowlisted PRs create no run at all", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 1, user: "octocat", headSha: SHA("1"), headRepo: "octocat/web" }, // allowlisted, but a fork
    { number: 2, user: "mallory", headSha: SHA("2"), headRepo: "acme/web" }, // same repo, not allowlisted
    { number: 3, user: "octocat", headSha: SHA("3"), headRepo: null }, // deleted fork
    { number: 4, user: "octocat", headSha: SHA("4"), headRepo: "acme/web", baseRepo: "acme/other" },
    { number: 5, user: "hubot", headSha: SHA("5"), headRepo: "acme/web" }, // the only good one
  ];
  const res = await poll(gh);
  const prs = (await listRuns(db, scope)).filter((r) => r.event === "pull_request");
  expect(prs.map((r) => r.prNumber)).toEqual([5]);
  expect(res.refused.map((r) => r.what).toSorted()).toEqual(["pr #1", "pr #2", "pr #3", "pr #4"]);
  expect(res.refused.find((r) => r.what === "pr #1")?.reason).toBe("head repo is a fork");
  // the workflow of a refused PR is never even fetched
  for (const sha of ["1", "2", "3", "4"]) {
    expect(gh.state.calls.some((c) => c.path.includes(`ref=${SHA(sha)}`))).toBe(false);
  }
  // with PR mode off, even the good PR is ignored and the PR list is not requested
  const gh2 = makeGithub();
  gh2.state.pulls = [{ number: 9, user: "octocat", headSha: SHA("9"), headRepo: "acme/web" }];
  const db2 = openDatabase(":memory:");
  await pollRepo(
    { db: db2, github: clientFor(gh2), provider: "docker" },
    config({ prMode: "off" }).repos[0]!,
  );
  expect(gh2.state.calls.some((c) => c.path.includes("/pulls"))).toBe(false);
  expect((await listRuns(db2, await ensureLocalTenant(db2))).map((r) => r.event)).toEqual(["push"]);
});

test("the hourly cap stops runs and lifts an hour later", async () => {
  const gh = makeGithub();
  const cfg = config({ maxRunsPerHour: 2 });
  const T = 1_800_000_000_000;
  await poll(gh, cfg, T);
  gh.state.head = { sha: SHA("b"), message: "m", login: "octocat" };
  await poll(gh, cfg, T + 60_000);
  gh.state.head = { sha: SHA("c"), message: "m", login: "octocat" };
  const capped = await poll(gh, cfg, T + 120_000);
  expect(capped.created).toEqual([]);
  expect(capped.refused[0]?.reason).toBe("hourly run cap reached");
  expect(await listRuns(db, scope)).toHaveLength(2);
  const later = await poll(gh, cfg, T + 3_700_000);
  expect(later.created).toHaveLength(1);
  expect(await listRuns(db, scope)).toHaveLength(3);
});

test("a workflow that is missing or invalid at the commit creates no run", async () => {
  const gh = makeGithub();
  gh.state.files.clear();
  const missing = await poll(gh);
  expect(missing.refused[0]?.reason).toContain("workflow not found");
  gh.state.files.set("*", "jobs: [not, a, map");
  expect((await poll(gh)).refused[0]?.reason).toContain("no jobs");
  gh.state.files.set("*", "name: empty\non: push\n");
  expect((await poll(gh)).created).toEqual([]);
  expect(await listRuns(db, scope)).toHaveLength(0);
});

test("conditional requests: an unchanged repo is answered with 304 and costs nothing", async () => {
  const gh = makeGithub();
  const client = clientFor(gh);
  const cfg = config().repos[0]!;
  const deps = { db, github: client, provider: "docker" };
  await pollRepo(deps, cfg);
  await pollRepo(deps, cfg);
  const heads = gh.state.calls.filter((c) => c.path.endsWith("/commits/main"));
  expect(heads).toHaveLength(2);
  expect(heads[0]!.headers["if-none-match"]).toBeUndefined();
  expect(heads[1]!.headers["if-none-match"]).toBe(`"head-${SHA("a")}"`);
  expect(await listRuns(db, scope)).toHaveLength(1);
});

test("rate limits surface as RateLimited with the reset time, and the poller backs off", async () => {
  const gh = makeGithub();
  gh.state.fail = {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000100" },
  };
  const err = await pollRepo(
    { db, github: clientFor(gh), provider: "docker" },
    config().repos[0]!,
  ).catch((e) => e);
  expect(err).toBeInstanceOf(RateLimited);
  expect((err as RateLimited).resetAt).toBe(1_800_000_100_000);
  // a plain 403 (not a rate limit) is an ordinary error
  gh.state.fail = { status: 403 };
  const plain = await pollRepo(
    { db, github: clientFor(gh), provider: "docker" },
    config().repos[0]!,
  ).catch((e) => e);
  expect(plain).not.toBeInstanceOf(RateLimited);

  const logs: string[] = [];
  gh.state.fail = { status: 429, headers: { "x-ratelimit-reset": "1800000100" } };
  const poller = new Poller({
    db,
    config: config(),
    fetch: gh.fetch,
    now: () => 1_800_000_000_000,
    log: (m) => logs.push(m),
  });
  await poller.pollAll();
  expect(logs.some((l) => l.includes("rate limited, backing off 100s"))).toBe(true);
});

test("the token comes from a file, goes only into the Authorization header, and is never logged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-poll-"));
  try {
    const secret = `tok-${randomUUID()}`;
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${secret}\n`);
    const gh = makeGithub();
    const logs: string[] = [];
    const queued: number[] = [];
    const poller = new Poller({
      db,
      config: config({}, { tokenFile }),
      fetch: gh.fetch,
      log: (m) => logs.push(m),
      onQueued: () => queued.push(1),
    });
    await poller.pollAll();
    expect(queued).toHaveLength(1);
    expect(gh.state.calls.length).toBeGreaterThan(0);
    for (const c of gh.state.calls) expect(c.headers.authorization).toBe(`Bearer ${secret}`);

    // failures never echo the token, the headers or the file's content
    gh.state.fail = { status: 500 };
    await poller.pollAll();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(secret);

    // no token configured: no Authorization header at all
    const anon = makeGithub();
    await new Poller({
      db: openDatabase(":memory:"),
      config: config(),
      fetch: anon.fetch,
    }).pollAll();
    for (const c of anon.state.calls) expect(c.headers.authorization).toBeUndefined();

    // a missing or empty token file is a startup error that does not leak content
    expect(
      () =>
        new Poller({ db, config: config({}, { tokenFile: join(dir, "nope") }), fetch: gh.fetch }),
    ).toThrow(/cannot read token file/);
    writeFileSync(join(dir, "empty"), "\n");
    expect(
      () =>
        new Poller({ db, config: config({}, { tokenFile: join(dir, "empty") }), fetch: gh.fetch }),
    ).toThrow(/is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: strict, defaults to safe values, and refuses an inline token", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-poll-"));
  try {
    const write = (obj: unknown) => {
      const p = join(dir, "c.json");
      writeFileSync(p, JSON.stringify(obj));
      return p;
    };
    const base = {
      repos: [{ repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" }],
    };
    const cfg = loadPollConfig(write(base));
    expect(cfg.repos[0]).toMatchObject({
      intervalSeconds: 60,
      prMode: "off",
      authors: [],
      maxRunsPerHour: 30,
      org: "local",
      project: "local",
    });
    expect(cfg.apiBaseUrl).toBe("https://api.github.com");

    expect(() => loadPollConfig(write({ ...base, token: "hunter2hunter2" }))).toThrow(
      /invalid poll config/,
    );
    expect(() => loadPollConfig(write({ ...base, token: "hunter2hunter2" }))).not.toThrow(
      /hunter2/,
    );
    expect(() =>
      loadPollConfig(write({ repos: [{ ...base.repos[0], prmode: "allowlist" }] })),
    ).toThrow(/prmode|Unrecognized/i);
    expect(() =>
      loadPollConfig(write({ repos: [{ ...base.repos[0], repo: "not-a-repo" }] })),
    ).toThrow(/owner\/name/);
    expect(() => loadPollConfig(write({ repos: [{ ...base.repos[0], prMode: "all" }] }))).toThrow(
      /prMode/,
    );
    expect(() => loadPollConfig(write({ repos: [] }))).toThrow(/invalid poll config/);
    expect(() => loadPollConfig(join(dir, "missing.json"))).toThrow(/cannot read poll config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a poll that fails on one repo does not stop the others, and is retried", async () => {
  const gh = makeGithub();
  const logs: string[] = [];
  const cfg = pollConfigSchema.parse({
    repos: [
      { repo: "acme/missing", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      { repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
    ],
  });
  const poller = new Poller({ db, config: cfg, fetch: gh.fetch, log: (m) => logs.push(m) });
  await poller.pollAll();
  expect(logs.some((l) => l.includes("acme/missing failed"))).toBe(true);
  expect(await listRuns(db, scope)).toHaveLength(1);
});
