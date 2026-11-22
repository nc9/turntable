import { beforeEach, expect, test } from "bun:test";
import {
  ensureLocalTenant,
  getRun,
  listJobs,
  listRuns,
  openDatabase,
  type Db,
  type Scope,
} from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { SHA, makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  guard:
    if: github.event_name == 'merge_group'
    runs-on: ubuntu-latest
    steps:
      - run: echo "base is \${{ github.event.merge_group.base_sha }}"
`;

let db: Db;
let scope: Required<Scope>;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

const config = (over: Record<string, unknown> = {}) =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "off",
        authors: ["octocat"],
        mergeQueue: true,
        ...over,
      },
    ],
  }).repos[0]!;

const poll = (gh: ReturnType<typeof makeGithub>, cfg = config(), now = 1_800_000_000_000) =>
  pollRepo(
    {
      db,
      github: new GithubClient({ baseUrl: "https://api.github.test", fetch: gh.fetch }),
      provider: "docker",
      now: () => now,
    },
    cfg,
  );

const QSHA = SHA("c");
const queueRef = (n: number, base = SHA("b")) =>
  `refs/heads/gh-readonly-queue/main/pr-${n}-${base}`;

function world() {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  gh.state.pulls.push({ number: 7, user: "octocat", headSha: SHA("d") });
  gh.state.queue.push({ ref: queueRef(7), sha: QSHA });
  return gh;
}

test("a verified queue commit for an allowlisted same-repo PR becomes a merge_group run", async () => {
  const gh = world();
  const res = await poll(gh);
  expect(res.created).toHaveLength(2); // the default branch push and the queue run
  const runs = await listRuns(db, scope);
  const run = runs.find((r) => r.event === "merge_group")!;
  expect(run.sha).toBe(QSHA);
  expect(run.ref).toBe(queueRef(7));
  expect(run.headBranch).toBe(`gh-readonly-queue/main/pr-7-${SHA("b")}`);
  expect(run.actor).toBe("octocat");
  const full = (await getRun(db, scope, run.id))!;
  const plan = JSON.parse(full.plan as string) as {
    trust: string;
    github: { event_name: string; event: { merge_group: Record<string, string> } };
  };
  expect(plan.trust).toBe("trusted_pr"); // no secrets, no write token
  expect(plan.github.event_name).toBe("merge_group");
  expect(plan.github.event.merge_group).toMatchObject({
    head_sha: QSHA,
    head_ref: queueRef(7),
    base_ref: "refs/heads/main",
    base_sha: SHA("b"),
  });
  // the merge_group-only job is in the plan
  expect((await listJobs(db, scope, run.id)).map((j) => j.name).sort()).toEqual(["build", "guard"]);
  // idempotent
  expect((await poll(gh)).created).toEqual([]);
});

test("off by default: a queue branch is not even listed", async () => {
  const gh = world();
  const res = await poll(gh, config({ mergeQueue: false }));
  expect(res.created).toHaveLength(1);
  expect(gh.state.calls.some((c) => c.path.includes("matching-refs"))).toBe(false);
});

test("a branch someone with write access made to look like a queue branch is refused", async () => {
  for (const bad of [
    { verified: false },
    { committerEmail: "someone@example.com" },
    { verified: false, committerEmail: "noreply@github.com" },
  ]) {
    const gh = world();
    Object.assign(gh.state.queue[0]!, bad);
    const res = await poll(gh, config(), 1_800_000_000_000);
    expect(res.created).toHaveLength(1); // only the push
    expect(
      res.refused.some((r) => r.reason === "queue commit is not a verified GitHub commit"),
    ).toBe(true);
    db = openDatabase(":memory:");
    scope = await ensureLocalTenant(db);
  }
});

test("the PR must be open, in this repo and by a listed author; the name must match", async () => {
  const closed = world();
  closed.state.pulls.length = 0;
  expect((await poll(closed)).refused.some((r) => r.reason === "pr #7 is not open")).toBe(true);

  for (const [pull, why] of [
    [{ number: 7, user: "stranger", headSha: SHA("d") }, /author is not on the allowlist/],
    [
      { number: 7, user: "octocat", headSha: SHA("d"), headRepo: "evil/web" },
      /head repo is a fork/,
    ],
  ] as const) {
    db = openDatabase(":memory:");
    scope = await ensureLocalTenant(db);
    const gh = world();
    gh.state.pulls[0] = pull;
    const res = await poll(gh);
    expect(res.created).toHaveLength(1);
    expect(res.refused.some((r) => why.test(r.reason))).toBe(true);
    expect((await listRuns(db, scope)).some((r) => r.event === "merge_group")).toBe(false);
  }

  // a name for another base branch, or a malformed one, is ignored
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  const odd = world();
  odd.state.queue[0]!.ref = `refs/heads/gh-readonly-queue/main/pr-7-nothex`;
  expect((await poll(odd)).created).toHaveLength(1);
});

test("a webhook for merge_group wakes the poller for the repo", async () => {
  const { createWebhookHandler, WEBHOOK_PATH } = await import("../src/github/webhook");
  const { WEBHOOK_SECRET, fakeFacts, setup, sign } = await import("./github-helpers");
  const s = await setup();
  const woke: string[] = [];
  const handler = createWebhookHandler({
    db: s.db,
    store: s.store,
    facts: fakeFacts().facts,
    onRepoEvent: (repo, event) => void woke.push(`${repo}:${event}`),
    log: () => {},
  });
  const body = JSON.stringify({
    action: "checks_requested",
    repository: { full_name: "acme/web" },
  });
  await handler.handle(
    new Request(`http://x${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "x-github-event": "merge_group",
        "x-github-delivery": "00000000-bbbb-0000-0000-000000000001",
        "x-hub-signature-256": sign(WEBHOOK_SECRET, body),
      },
      body,
    }),
  );
  await handler.drain();
  expect(woke).toEqual(["acme/web:merge_group"]);
});
