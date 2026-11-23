// A push run's `before` (github.event.before and the path filters' base): GitHub's own value from
// the events API when it has one, else the head commit's first parent, else the last sha the
// poller handled. The source is recorded in the run's facts. `everyPush` (off by default) makes a
// run for each default-branch push missed between two polls.
import { beforeEach, describe, expect, test } from "bun:test";
import { ensureLocalTenant, listRuns, openDatabase, type Db, type Scope } from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { makeGithub, SHA } from "./github-stub";

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

let db: Db;
let scope: Required<Scope>;
let now = 1_800_000_000_000;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  now = 1_800_000_000_000;
});

const chain = (...shas: string[]) =>
  shas.map((sha, i) => ({ sha, parents: shas[i + 1] ? [shas[i + 1] as string] : [] }));

function world(o: { everyPush?: boolean } = {}) {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        everyPush: o.everyPush ?? false,
        maxRunsPerHour: 1000,
      },
    ],
  }).repos[0]!;
  const github = new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" });
  return { gh, cfg, github };
}
const poll = (w: ReturnType<typeof world>) => {
  now += 60_000;
  return pollRepo({ db, github: w.github, provider: "docker", now: () => now }, w.cfg);
};
const setHead = (w: ReturnType<typeof world>, sha: string) => {
  w.gh.state.head = { sha, message: `commit ${sha[0]}`, login: "octocat" };
};
const pushRuns = async () =>
  (await listRuns(db, scope, { limit: 100 }))
    .filter((r) => r.ref === "refs/heads/main")
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));
const factsOf = (r: { trust: string | null }) =>
  JSON.parse(r.trust!).facts as Record<string, unknown>;
const beforeOf = (r: { plan: string | null }) =>
  (JSON.parse(r.plan!).github.event as { before?: string }).before;

describe("where a push's before comes from", () => {
  test("the events API's PushEvent for that head is GitHub's own before", async () => {
    const w = world();
    w.gh.state.history = chain(SHA("a"), SHA("b"), SHA("c"));
    w.gh.state.events = [{ ref: "refs/heads/main", head: SHA("a"), before: SHA("e") }];
    await poll(w);
    const [run] = await pushRuns();
    expect(factsOf(run!)).toMatchObject({ beforeSource: "events" });
    expect(beforeOf(run!)).toBe(SHA("e"));
  });

  test("with no event for it, a single-parent head's before is its parent", async () => {
    const w = world();
    w.gh.state.history = chain(SHA("a"), SHA("b"), SHA("c"));
    w.gh.state.events = [{ ref: "refs/heads/other", head: SHA("a"), before: SHA("e") }];
    await poll(w);
    const [run] = await pushRuns();
    expect(factsOf(run!)).toMatchObject({ beforeSource: "first_parent" });
    expect(beforeOf(run!)).toBe(SHA("b"));
  });

  test("an events API that fails falls back to the parent", async () => {
    const w = world();
    w.gh.state.history = chain(SHA("a"), SHA("b"));
    w.gh.state.eventsStatus = 500;
    await poll(w);
    expect(factsOf((await pushRuns())[0]!)).toMatchObject({ beforeSource: "first_parent" });
  });

  test("a merge commit has no single parent: the last polled sha, or none the first time", async () => {
    const w = world();
    w.gh.state.history = [{ sha: SHA("a"), parents: [SHA("b"), SHA("d")] }, ...chain(SHA("b"))];
    await poll(w);
    expect(factsOf((await pushRuns())[0]!)).toMatchObject({ beforeSource: "none" });
    expect(beforeOf((await pushRuns())[0]!)).toBeUndefined();
    setHead(w, SHA("f"));
    w.gh.state.history = [{ sha: SHA("f"), parents: [SHA("a"), SHA("d")] }, ...w.gh.state.history];
    await poll(w);
    const second = (await pushRuns())[1]!;
    expect(factsOf(second)).toMatchObject({ beforeSource: "last_polled" });
    expect(beforeOf(second)).toBe(SHA("a"));
  });

  test("the path filter uses the same before: a skipped push's files are not blamed on this one", async () => {
    const w = world();
    w.gh.state.history = chain(SHA("c"));
    setHead(w, SHA("c"));
    await poll(w); // handled c (no before: path filters not applied)
    expect(await pushRuns()).toHaveLength(1);
    // b was pushed and missed (it touched src/); a is the head and touched only the README
    w.gh.state.history = chain(SHA("a"), SHA("b"), SHA("c"));
    setHead(w, SHA("a"));
    w.gh.state.compare.set(`${SHA("b")}...${SHA("a")}`, ["README.md"]);
    w.gh.state.compare.set(`${SHA("c")}...${SHA("a")}`, ["src/x.ts", "README.md"]);
    const r = await poll(w);
    // GitHub's before for a is b: README only, so the workflow does not trigger
    expect(r.refused.some((x) => x.reason.startsWith("not triggered"))).toBe(true);
    expect(await pushRuns()).toHaveLength(1);
  });
});

describe("everyPush", () => {
  const missed = async (everyPush: boolean) => {
    const w = world({ everyPush });
    w.gh.state.history = chain(SHA("c"));
    setHead(w, SHA("c"));
    await poll(w);
    w.gh.state.history = chain(SHA("a"), SHA("b"), SHA("c"));
    setHead(w, SHA("a"));
    for (const x of ["a", "b"])
      w.gh.state.compare.set(`${SHA(x === "a" ? "b" : "c")}...${SHA(x)}`, ["src/x.ts"]);
    await poll(w);
    return { w, runs: await pushRuns() };
  };

  test("off by default: only the head becomes a run", async () => {
    const { runs } = await missed(false);
    expect(runs.map((r) => r.sha)).toEqual([SHA("c"), SHA("a")]);
  });

  test("on: each missed push is its own run, oldest first, each with its own before", async () => {
    const { runs } = await missed(true);
    expect(runs.map((r) => r.sha)).toEqual([SHA("c"), SHA("b"), SHA("a")]);
    expect(runs.slice(1).map(beforeOf)).toEqual([SHA("c"), SHA("b")]);
  });

  test("at most five missed pushes a poll, the newest; a force push has no gap to fill", async () => {
    const w = world({ everyPush: true });
    w.gh.state.history = chain(SHA("0"));
    setHead(w, SHA("0"));
    await poll(w);
    const shas = ["9", "8", "7", "6", "5", "4", "3", "2", "1"].map((c) => SHA(c));
    w.gh.state.history = chain(...shas, SHA("0"));
    setHead(w, shas[0]!);
    await poll(w);
    // the head and the five newest missed pushes; the three oldest are not made
    expect((await pushRuns()).map((r) => r.sha)).toEqual(
      ["0", "4", "5", "6", "7", "8", "9"].map((c) => SHA(c)),
    );
  });

  test("a force push (the last handled sha is not behind the head) makes no catch-up runs", async () => {
    const w = world({ everyPush: true });
    w.gh.state.history = chain(SHA("c"));
    setHead(w, SHA("c"));
    await poll(w);
    w.gh.state.history = chain(SHA("a"), SHA("b"), SHA("d"));
    setHead(w, SHA("a"));
    await poll(w);
    expect((await pushRuns()).map((r) => r.sha)).toEqual([SHA("c"), SHA("a")]);
  });
});
