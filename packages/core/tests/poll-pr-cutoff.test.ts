import { beforeEach, expect, test } from "bun:test";
import { ensureLocalTenant, listRuns, openDatabase, type Db, type Scope } from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo, type PollConfig } from "../src/poll";

let db: Db;
let scope: Required<Scope>;

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const REPO = "acme/web";

type Pull = { number: number; headSha: string; updatedAt: number };

/** A GitHub stand-in served through fetch: a default branch, and open PRs by one author. */
function makeGithub() {
  const state = { pulls: [] as Pull[] };
  const fetchStub = async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === `/repos/${REPO}/commits/main`) {
      return Response.json({
        sha: SHA(1),
        commit: { message: "feat: main" },
        author: { login: "octocat" },
      });
    }
    if (u.pathname === `/repos/${REPO}/branches/main`) return Response.json({ protected: true });
    const commit = new RegExp(`^/repos/${REPO}/commits/([0-9a-f]{40})$`).exec(u.pathname);
    if (commit) {
      return Response.json({
        sha: commit[1],
        commit: { message: "a pr commit" },
        author: { login: "octocat" },
      });
    }
    if (u.pathname === `/repos/${REPO}/pulls`) {
      return Response.json(
        state.pulls.map((p) => ({
          number: p.number,
          title: `PR ${p.number}`,
          updated_at: new Date(p.updatedAt).toISOString(),
          user: { login: "octocat" },
          head: { sha: p.headSha, ref: "topic", repo: { full_name: REPO } },
          base: { repo: { full_name: REPO }, ref: "main" },
        })),
      );
    }
    if (u.pathname === `/repos/${REPO}/contents/.github/workflows/ci.yml`) {
      return new Response(WORKFLOW);
    }
    return new Response("unexpected", { status: 500 });
  };
  return { state, fetch: fetchStub };
}

const config = (over: Partial<PollConfig["repos"][number]> = {}): PollConfig =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: REPO,
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        authors: ["octocat"],
        ...over,
      },
    ],
  });

const poll = (gh: ReturnType<typeof makeGithub>, cfg: PollConfig, now: number, database = db) =>
  pollRepo(
    {
      db: database,
      github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
      provider: "docker",
      now: () => now,
    },
    cfg.repos[0]!,
  );

const prRuns = async (database = db) =>
  (await listRuns(database, scope)).filter((r) => r.event === "pull_request");

/** `n` open PRs last updated `ageHours` before T0. */
const stale = (n: number, ageHours = 72): Pull[] =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    headSha: SHA(100 + i),
    updatedAt: T0 - ageHours * HOUR,
  }));

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

test("enabling PR mode on a repo with 20 stale open PRs queues no PR runs", async () => {
  const gh = makeGithub();
  gh.state.pulls = stale(20);
  await poll(gh, config(), T0);
  expect(await prRuns()).toHaveLength(0);
  // Still nothing on later polls: each head is remembered as seen.
  await poll(gh, config(), T0 + 120_000);
  expect(await prRuns()).toHaveLength(0);
});

test("a push to one stale PR after the cutoff queues exactly one run", async () => {
  const gh = makeGithub();
  gh.state.pulls = stale(20);
  await poll(gh, config(), T0);
  gh.state.pulls[4] = { number: 5, headSha: SHA(999), updatedAt: T0 + 60_000 };
  await poll(gh, config(), T0 + 120_000);
  const runs = await prRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ prNumber: 5, sha: SHA(999) });
});

test("a restart over the same database does not backfill", async () => {
  const gh = makeGithub();
  gh.state.pulls = stale(20);
  await poll(gh, config(), T0);
  // A new ingest instance later: the persisted cutoff is the first poll, not this poll's time.
  await poll(gh, config(), T0 + 10 * HOUR);
  expect(await prRuns()).toHaveLength(0);
});

test("prSince overrides the default cutoff", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 1, headSha: SHA(101), updatedAt: T0 - 48 * HOUR },
    { number: 2, headSha: SHA(102), updatedAt: T0 - 5 * HOUR },
  ];
  const since = new Date(T0 - 24 * HOUR).toISOString();
  await poll(gh, config({ prSince: since }), T0);
  expect((await prRuns()).map((r) => r.prNumber)).toEqual([2]);
  // An earlier prSince admits both on a fresh database.
  const db2 = openDatabase(":memory:");
  scope = await ensureLocalTenant(db2);
  const early = new Date(T0 - 72 * HOUR).toISOString();
  await poll(gh, config({ prSince: early }), T0, db2);
  expect((await prRuns(db2)).map((r) => r.prNumber).sort()).toEqual([1, 2]);
});

test("prMaxAgeHours overrides the default cutoff", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 1, headSha: SHA(101), updatedAt: T0 - 48 * HOUR },
    { number: 2, headSha: SHA(102), updatedAt: T0 - 5 * HOUR },
  ];
  await poll(gh, config({ prMaxAgeHours: 24 }), T0);
  const runs = await prRuns();
  expect(runs.map((r) => r.prNumber)).toEqual([2]);
});

test("prNumbers still picks PRs regardless of the cutoff", async () => {
  const gh = makeGithub();
  gh.state.pulls = stale(20);
  await poll(gh, config({ prNumbers: [3, 7] }), T0);
  expect((await prRuns()).map((r) => r.prNumber).sort()).toEqual([3, 7]);
});

test("turning PR mode off and on again starts a new cutoff", async () => {
  const gh = makeGithub();
  gh.state.pulls = stale(3);
  await poll(gh, config(), T0);
  await poll(gh, config({ prMode: "off" }), T0 + HOUR);
  gh.state.pulls.push({ number: 9, headSha: SHA(900), updatedAt: T0 + 2 * HOUR });
  await poll(gh, config(), T0 + 3 * HOUR);
  expect((await prRuns()).map((r) => r.prNumber)).toEqual([9]);
});
