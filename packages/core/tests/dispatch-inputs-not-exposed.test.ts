import { beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  appendLog,
  bindRepo,
  createAttempt,
  createOrg,
  createProject,
  type Db,
  listAudit,
  listEvents,
  listJobs,
  openDatabase,
  type Scope,
  upsertStep,
} from "../src/db";
import { resultText } from "../src/mcp/envelope";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { Poller, pollConfigSchema } from "../src/poll";
import { buildActEvent } from "../src/run/act-event";
import { mintToken } from "./ops-helpers";
import { makeGithub, SHA } from "./github-stub";

// A workflow_dispatch input value is caller-supplied. It is stored with the run and may enter the
// act event JSON; nothing Turntable returns or records may carry it: no operation result (REST or
// MCP text), no event, no audit row. This dispatches with a unique marker and looks everywhere.

const WORKFLOW = `name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo building
`;

const MARK = "DISPINPUT-" + randomBytes(12).toString("hex");

let db: Db;
let scope: Required<Scope>;
let env: DispatchEnv;
let readerTok: string;
let runId: string;
let jobId: string;
let dispatchOut: unknown;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const o = await createOrg(db, { slug: "acme", name: "acme" });
  const p = await createProject(db, { orgId: o.id }, { slug: "app", name: "App" });
  scope = { orgId: o.id, projectId: p.id };
  await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web" });
  const gh = makeGithub("acme/web", ".github/workflows/release.yml");
  gh.state.files.set("*", WORKFLOW);
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        org: "acme",
        project: "app",
        workflow: ".github/workflows/release.yml",
        defaultBranch: "main",
      },
    ],
  });
  const poller = new Poller({ db, config: cfg, fetch: gh.fetch, now: () => 1_800_000_000_000 });
  env = {
    registry,
    db,
    runDispatcher: (s, r, q) => poller.dispatch(s, r, q),
  };
  const maintainer = (await mintToken(db, scope, "release_operator", { kind: "person" })).secret;
  const res = await dispatch(env, { kind: "bearer", token: maintainer }, "run_dispatch", {
    project: "app",
    workflow: ".github/workflows/release.yml",
    ref: "main",
    inputs: { version: `${MARK}-v1` },
  });
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  dispatchOut = res.output;
  runId = (res.output as { run_id: string }).run_id;
  const job = (await listJobs(db, scope, runId))[0]!;
  jobId = job.id;
  // The runner's records: an attempt, a step and a log that does not echo the input.
  const attempt = (await createAttempt(db, scope, { jobId, provider: "fake" }))!;
  await appendLog(db, scope, attempt.id, 0, new TextEncoder().encode("building\ndone\n"));
  await upsertStep(db, scope, {
    attemptId: attempt.id,
    stepKey: "s0",
    stage: "main",
    index: 0,
    name: "Run echo building",
    result: "success",
    startedAt: null,
    finishedAt: null,
    logOffset: 0,
  });
  readerTok = (await mintToken(db, { orgId: scope.orgId }, "reader")).secret;
});

async function call(op: string, input: unknown = {}): Promise<unknown> {
  const res = await dispatch(env, { kind: "bearer", token: readerTok }, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output;
}

/** What REST returns (the output JSON) and what MCP returns (its wrapped text). */
function surfaces(op: string, output: unknown): string {
  return JSON.stringify(output) + resultText(op, output, true) + resultText(op, output, false);
}

test("positive control: the input value is in the act event JSON built for the run", async () => {
  const run = (await call("get_run", { run_id: runId })) as { run: unknown };
  expect(JSON.stringify(run)).not.toContain(MARK);
  const stored = (await db.orm.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) }))!;
  const ev = JSON.stringify(buildActEvent(stored));
  expect(ev).toContain(`${MARK}-v1`);
});

test("no operation result, event or audit row carries a dispatch input value", async () => {
  const outputs: [string, unknown][] = [
    ["run_dispatch", dispatchOut],
    ["get_run", await call("get_run", { run_id: runId })],
    ["list_runs", await call("list_runs")],
    ["job_steps", await call("job_steps", { job_id: jobId })],
    ["job_log", await call("job_log", { job_id: jobId })],
    ["checks_for_sha", await call("checks_for_sha", { sha: SHA("a") })],
    ["events", await call("events")],
  ];
  for (const [op, out] of outputs) {
    expect(JSON.stringify(out).length).toBeGreaterThan(20);
    expect(surfaces(op, out)).not.toContain(MARK);
  }
  expect(JSON.stringify(outputs[6]![1])).toContain(runId);
  const rows = await listEvents(db, scope, { after: 0, limit: 500 } as never);
  expect(rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(rows)).not.toContain(MARK);
  const audit = await listAudit(db, scope);
  expect(audit.some((r) => r.op === "run_dispatch")).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(MARK);
});
