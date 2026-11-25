// Issue #633: the planner's `if:` sees the same github context as act's event file, a draft PR's
// jobs are skipped, a ready PR runs, and a draft flip at the same head re-ingests exactly when the
// workflow's `types` ask for it. Each case runs on SQLite and on Postgres (pglite).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { evaluateCondition, type Value } from "@turntable/act-runner";
import {
  type Db,
  ensureLocalTenant,
  listJobs,
  listRuns,
  openDatabase,
  type Scope,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { buildActEvent, type ActEventRun } from "../src/run/act-event";
import { SHA, makeGithub } from "./github-stub";

setDefaultTimeout(30_000);

const opened: Db[] = [];
afterAll(() => {
  for (const d of opened) d.close();
});

const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  [
    "postgres",
    () => {
      const t = testDb();
      return openPostgres(
        t && t !== "pglite"
          ? { url: t, schema: `lstest_pr_draft_${process.pid}` }
          : { pglite: true },
        { fresh: true },
      );
    },
  ],
];

const GUARDS = [
  "github.event.pull_request.draft != true",
  "${{ github.event_name == 'pull_request' }}",
  "github.repository == 'acme/web'",
  "always() && github.repository == 'acme/web'",
  "github.event.pull_request.draft",
  "github.actor == 'octocat'",
  "github.ref == 'refs/pull/7/head'",
  "contains(github.event.pull_request.labels.*.name, 'ship')",
  "github.event.pull_request.head.repo.fork == false",
  "github.event.pull_request.base.ref == 'main'",
  "github.event.pull_request.number == 7",
];

const job = (n: number, cond: string) =>
  `  g${n}:\n    if: ${cond.includes("{{") ? cond : cond}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo g${n}\n`;
const workflow = (types: string) =>
  `name: CI\non:\n  pull_request:\n    types: [${types}]\njobs:\n${GUARDS.map((c, i) => job(i, c.replace(/'/g, "'"))).join("")}`;
const DEFAULT = "opened, synchronize, reopened";
const WITH_READY = "opened, synchronize, reopened, ready_for_review, converted_to_draft";

async function setup(open: () => Db) {
  const db = open();
  opened.push(db);
  const scope = await ensureLocalTenant(db);
  const gh = makeGithub();
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
  const poll = () =>
    pollRepo({ db, github, provider: "docker", now: () => 1_800_000_000_000 }, cfg.repos[0]!);
  const prRuns = async () =>
    (await listRuns(db, scope as Required<Scope>)).filter((r) => r.event === "pull_request");
  return { db, scope: scope as Required<Scope>, gh, poll, prRuns };
}

const actRun = (
  run: {
    event: string;
    ref: string;
    sha: string | null;
    prNumber: number | null;
    headBranch: string | null;
  },
  plan: string | null,
): ActEventRun => ({
  event: run.event,
  ref: run.ref,
  sha: run.sha,
  repo: "acme/web",
  prNumber: run.prNumber,
  headBranch: run.headBranch,
  plan,
});

const states = (jobs: { jobKey: string; planned?: string | null }[]) =>
  Object.fromEntries(
    jobs.map((j) => [
      j.jobKey,
      (JSON.parse(j.planned ?? "{}") as { staticSkip?: unknown }).staticSkip ? "skip" : "run",
    ]),
  );

const verdict = (cond: string, github: Record<string, Value>): boolean =>
  evaluateCondition(cond, { contexts: { github }, status: { needs: [], cancelled: false } });

for (const [name, open] of dialects) {
  test(`${name}: draft PR skips its draft-gated job, a ready PR runs it`, async () => {
    const t = await setup(open);
    t.gh.state.files.set("*", workflow(DEFAULT));
    t.gh.state.pulls = [
      { number: 7, user: "octocat", headSha: SHA("d"), draft: true, labels: ["ship"] },
    ];
    await t.poll();
    const [draft] = await t.prRuns();
    const dj = states(await listJobs(t.db, t.scope, draft!.id));
    expect(dj.g0).toBe("skip");
    expect(dj.g1).toBe("run");
    expect(dj.g2).toBe("run");
    expect(dj.g3).toBe("run");
    expect(dj.g4).toBe("run"); // plain `draft` is true here

    const t2 = await setup(open);
    t2.gh.state.files.set("*", workflow(DEFAULT));
    t2.gh.state.pulls = [
      { number: 7, user: "octocat", headSha: SHA("d"), draft: false, labels: ["ship"] },
    ];
    await t2.poll();
    const [ready] = await t2.prRuns();
    const rj = states(await listJobs(t2.db, t2.scope, ready!.id));
    expect(rj.g0).toBe("run");
    expect(rj.g4).toBe("skip");
  });

  test(`${name}: every guard gives the same verdict in the planner context and in act's event`, async () => {
    for (const draft of [true, false]) {
      const t = await setup(open);
      t.gh.state.files.set("*", workflow(DEFAULT));
      t.gh.state.pulls = [
        { number: 7, user: "octocat", headSha: SHA("d"), draft, labels: ["ship"] },
      ];
      await t.poll();
      const [run] = await t.prRuns();
      const plan = (run as { plan?: string | null }).plan ?? null;
      const planner = (JSON.parse(plan!) as { github: Record<string, Value> }).github;
      // What act is given: the event file, plus the github keys act derives itself.
      const actGithub: Record<string, Value> = {
        event_name: run!.event,
        ref: run!.ref,
        actor: run!.actor ?? "",
        repository: "acme/web",
        event: buildActEvent(actRun(run!, plan)) as Value,
      };
      expect(planner.repository).toBe("acme/web");
      expect(planner.repository_owner).toBe("acme");
      for (const g of GUARDS) {
        const c = g.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
        expect(verdict(c, planner)).toBe(verdict(c, actGithub));
      }
      expect(verdict("github.event.pull_request.draft != true", actGithub)).toBe(!draft);
    }
  });

  test(`${name}: the stored event and act's event file carry the PR fields`, async () => {
    const t = await setup(open);
    t.gh.state.files.set("*", workflow(DEFAULT));
    t.gh.state.pulls = [
      { number: 7, user: "octocat", headSha: SHA("d"), draft: true, labels: ["ship"] },
    ];
    await t.poll();
    const [run] = await t.prRuns();
    const plan = (run as { plan?: string | null }).plan ?? null;
    const stored = (JSON.parse(plan!) as { github: { event: unknown } }).github.event;
    const ev = buildActEvent(actRun(run!, plan)) as any;
    expect(ev).toEqual(stored as any); // poll payload == what act reads
    expect(ev.pull_request).toMatchObject({
      number: 7,
      draft: true,
      labels: [{ name: "ship" }],
      user: { login: "octocat" },
      head: { ref: expect.any(String), repo: { full_name: "acme/web", fork: false } },
      base: { ref: "main" },
    });
    expect(ev.number).toBe(7);
  });

  test(`${name}: draft to ready at the same head re-ingests only when types list ready_for_review`, async () => {
    for (const [types, expectRuns] of [
      [DEFAULT, 1],
      [WITH_READY, 2],
    ] as const) {
      const t = await setup(open);
      t.gh.state.files.set("*", workflow(types));
      t.gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("d"), draft: true }];
      await t.poll();
      expect(await t.prRuns()).toHaveLength(1);
      t.gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("d"), draft: false }];
      await t.poll();
      await t.poll(); // a second poll does not repeat it
      const runs = await t.prRuns();
      expect(runs).toHaveLength(expectRuns);
      if (expectRuns === 2) {
        const latest = runs.find((r) =>
          (r as { plan?: string }).plan?.includes("ready_for_review"),
        )!;
        const jobs = states(await listJobs(t.db, t.scope, latest.id));
        expect(jobs.g0).toBe("run");
        const ev = buildActEvent(actRun(latest, (latest as { plan?: string }).plan ?? null)) as any;
        expect(ev.action).toBe("ready_for_review");
        expect(ev.pull_request.draft).toBe(false);
      }
    }
  });

  test(`${name}: ready to draft at the same head is converted_to_draft, off by default`, async () => {
    for (const [types, expectRuns] of [
      [DEFAULT, 1],
      [WITH_READY, 2],
    ] as const) {
      const t = await setup(open);
      t.gh.state.files.set("*", workflow(types));
      t.gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("d"), draft: false }];
      await t.poll();
      t.gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("d"), draft: true }];
      await t.poll();
      expect(await t.prRuns()).toHaveLength(expectRuns);
    }
  });
}
