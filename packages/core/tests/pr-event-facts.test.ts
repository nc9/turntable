import { beforeEach, expect, test } from "bun:test";
import {
  type Db,
  ensureLocalTenant,
  listJobs,
  listRuns,
  openDatabase,
  type Scope,
} from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { MAX_PR_BODY_BYTES } from "../src/poll/github";
import { buildActEvent, type ActEventRun } from "../src/run/act-event";
import { SHA, makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on: [pull_request]
jobs:
  bots:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - run: echo bots
  ready:
    if: \${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - run: echo ready
`;

let db: Db;
let scope: Required<Scope>;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

async function ingest(gh: ReturnType<typeof makeGithub>) {
  gh.state.files.set("*", WORKFLOW);
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat", "dependabot[bot]"],
      },
    ],
  });
  const github = new GithubClient({
    fetch: gh.fetch,
    baseUrl: "https://api.github.com",
    token: undefined,
  });
  await pollRepo({ db, github, provider: "docker", now: () => 1_800_000_000_000 }, cfg.repos[0]!);
  const run = (await listRuns(db, scope)).find((r) => r.event === "pull_request")!;
  const jobs = await listJobs(db, scope, run.id);
  return { run, jobs };
}

const actRun = (run: Awaited<ReturnType<typeof ingest>>["run"]): ActEventRun => ({
  event: run.event,
  ref: run.ref,
  sha: run.sha,
  repo: "acme/web",
  prNumber: run.prNumber,
  headBranch: run.headBranch,
  plan: (run as { plan?: string | null }).plan ?? null,
});

/** What each job's plan-time `if:` decided: "skip" when the planner folded it to false. */
const jobStates = (jobs: { jobKey: string; planned?: string | null }[]) =>
  Object.fromEntries(
    jobs.map((j) => [
      j.jobKey,
      (JSON.parse(j.planned ?? "{}") as { staticSkip?: unknown }).staticSkip ? "skip" : "run",
    ]),
  );

test("the event JSON carries user, title, body, labels, draft, head repo and sender", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    {
      number: 7,
      user: "dependabot[bot]",
      userType: "Bot",
      headSha: SHA("d"),
      title: "chore: bump x",
      body: "bumps x",
      labels: ["ship", "deps"],
      draft: true,
    },
  ];
  const { run } = await ingest(gh);
  const ev = buildActEvent(actRun(run)) as any;
  expect(ev.pull_request).toMatchObject({
    number: 7,
    title: "chore: bump x",
    body: "bumps x",
    labels: [{ name: "ship" }, { name: "deps" }],
    draft: true,
    user: { login: "dependabot[bot]", type: "Bot" },
    head: { repo: { full_name: "acme/web", fork: false } },
    base: { repo: { full_name: "acme/web" } },
  });
  expect(ev.sender).toEqual({ login: "dependabot[bot]", type: "Bot" });
  // a rerun rebuilds the identical payload from what the run stored
  expect(buildActEvent(actRun(run))).toEqual(ev);
});

test("the real draft flag, and the author, gate jobs through plan-time expressions", async () => {
  const gh = makeGithub();
  gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("d"), draft: true }];
  const draft = await ingest(gh);
  expect(jobStates(draft.jobs)).toMatchObject({
    bots: "skip",
    ready: "skip",
  });
  expect((buildActEvent(actRun(draft.run)) as any).pull_request.draft).toBe(true);

  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  const gh2 = makeGithub();
  gh2.state.pulls = [
    {
      number: 8,
      user: "dependabot[bot]",
      userType: "Bot",
      headSha: SHA("e"),
      draft: false,
      labels: ["ship"],
    },
  ];
  const ready = await ingest(gh2);
  expect(jobStates(ready.jobs)).toMatchObject({
    bots: "run",
    ready: "run",
  });
});

test("a body over the cap is cut at a character boundary", async () => {
  const gh = makeGithub();
  gh.state.pulls = [
    { number: 7, user: "octocat", headSha: SHA("d"), body: "é".repeat(MAX_PR_BODY_BYTES) },
  ];
  const { run } = await ingest(gh);
  const body = (buildActEvent(actRun(run)) as any).pull_request.body as string;
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_PR_BODY_BYTES);
  expect(body).toBe("é".repeat(MAX_PR_BODY_BYTES / 2));
});

test("hostile title, body and labels stay data: verbatim in the event, nowhere else", async () => {
  const hostile = "x ${{ github.token }} `id` $(id) <script>";
  const gh = makeGithub();
  gh.state.pulls = [
    {
      number: 7,
      user: "octocat",
      headSha: SHA("d"),
      title: hostile,
      body: hostile,
      labels: [hostile],
    },
  ];
  const { run, jobs } = await ingest(gh);
  const ev = buildActEvent(actRun(run)) as any;
  expect(ev.pull_request.title).toBe(hostile);
  expect(ev.pull_request.body).toBe(hostile);
  expect(ev.pull_request.labels).toEqual([{ name: hostile }]);
  // Nothing but the stored plan (which holds the event JSON) and the event file carries it.
  const row = JSON.stringify({ ...run, plan: undefined });
  expect(row).not.toContain("github.token");
  expect(JSON.stringify(jobs)).not.toContain("github.token");
  expect(run.commitMessage).not.toContain("github.token");
});
