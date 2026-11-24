import { beforeEach, expect, test } from "bun:test";
import {
  appendLog,
  createAttempt,
  type Db,
  ensureLocalTenant,
  listEvents,
  listJobs,
  listRuns,
  openDatabase,
  type Scope,
  setProjectChecksMode,
  upsertStep,
} from "../src/db";
import type { Claim } from "../src/db/repos";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import * as s from "../src/db/schema";
import { resultText } from "../src/mcp/envelope";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { buildActEvent } from "../src/run/act-event";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { mintToken } from "./ops-helpers";
import { SHA, makeGithub } from "./github-stub";

// PR text (title, body, labels) is attacker-controlled. It may enter the act event JSON and
// nothing else: no operation result, no event, no check-run summary. This seeds a PR whose text
// carries a unique marker and hostile content, then looks for the marker everywhere Turntable
// renders, returns or summarises run data.

const WORKFLOW = `name: CI
on: [pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo building
`;

const MARK = "PRTEXT-" + crypto.randomUUID();
const HOSTILE = [
  "${{ github.token }}",
  "`id`",
  "$(id)",
  "[click](https://evil.example/x)",
  "<img src=x onerror=alert(1)>",
].join(" ");

let db: Db;
let scope: Required<Scope>;
let runId: string;
let jobId: string;
let claim: Claim;
let env: DispatchEnv;
let token: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  gh.state.pulls = [
    {
      number: 7,
      user: "octocat",
      headSha: SHA("d"),
      title: `${MARK}-title ${HOSTILE}`,
      body: `${MARK}-body ${HOSTILE}`,
      labels: [`${MARK}-label ${HOSTILE}`],
    },
  ];
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat"],
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
  runId = run.id;
  const job = (await listJobs(db, scope, run.id))[0]!;
  jobId = job.id;
  // The runner's records: an attempt, a step and a log that does not echo the PR text.
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  await appendLog(db, scope, attempt.id, 0, new TextEncoder().encode("building\ndone\n"));
  await upsertStep(db, scope, {
    attemptId: attempt.id,
    stepKey: "s0",
    stage: "main",
    index: 0,
    name: "Run echo building",
    result: "failure",
    startedAt: null,
    finishedAt: null,
    logOffset: 0,
  });
  claim = { attempt, job, run, scope };
  env = { registry, db };
  token = (await mintToken(db, { orgId: scope.orgId }, "reader")).secret;
});

async function call(op: string, input: unknown = {}): Promise<unknown> {
  const res = await dispatch(env, { kind: "bearer", token }, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output;
}

/** What REST returns (the output JSON) and what MCP returns (its wrapped text). */
function surfaces(op: string, output: unknown): string {
  return JSON.stringify(output) + resultText(op, output, true) + resultText(op, output, false);
}

test("positive control: the marker is in the act event JSON built for the run", async () => {
  const run = (await listRuns(db, scope)).find((r) => r.id === runId)!;
  const ev = JSON.stringify(
    buildActEvent({
      event: run.event,
      ref: run.ref,
      sha: run.sha,
      repo: "acme/web",
      prNumber: run.prNumber,
      headBranch: run.headBranch,
      plan: (run as { plan?: string | null }).plan ?? null,
    }),
  );
  expect(ev).toContain(`${MARK}-title`);
  expect(ev).toContain(`${MARK}-body`);
  expect(ev).toContain(`${MARK}-label`);
});

test("no operation result carries the PR title, body or label text", async () => {
  const sha = SHA("d");
  const outputs: [string, unknown][] = [
    ["get_run", await call("get_run", { run_id: runId })],
    ["list_runs", await call("list_runs")],
    ["job_steps", await call("job_steps", { job_id: jobId })],
    ["job_log", await call("job_log", { job_id: jobId })],
    ["checks_for_sha", await call("checks_for_sha", { sha })],
    ["events", await call("events")],
  ];
  for (const [op, out] of outputs) {
    // each op returned something real, so an absent marker is not an empty result
    expect(JSON.stringify(out).length).toBeGreaterThan(20);
    expect(surfaces(op, out)).not.toContain(MARK);
  }
  expect(JSON.stringify(outputs[5]![1])).toContain(runId);
  // the stored event rows feed both the events op and the webhook fan-out
  const rows = await listEvents(db, scope, { after: 0, limit: 500 } as never);
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(MARK);
});

test("the check-run summary the reporter renders carries no PR text", async () => {
  // ingest bound the repo without an App installation; give it one so the reporter posts
  await db.run((h) => h.orm.update(s.projectRepos).set({ installationId: "9001" }));
  await setProjectChecksMode(db, scope, "live");
  const posted: CheckRunBody[] = [];
  const api: CheckRunsApi = {
    async create(_t, _r, body) {
      posted.push(body);
      return "100";
    },
    async update(_t, _r, _id, body) {
      posted.push(body);
    },
    async findByExternalId() {
      return undefined;
    },
  };
  const auth: TokenMinter = { mint: async () => ({ token: "stub" }) };
  const reporter = new CheckReporter({
    db,
    auth,
    api,
    publicUrl: "https://ci.example.com",
    sleep: async () => {},
  });
  reporter.started(claim);
  reporter.finished(claim, { result: "failure", exitCode: 1 } as never);
  await reporter.idle();
  expect(posted.length).toBeGreaterThan(0);
  expect(JSON.stringify(posted)).not.toContain(MARK);
});
