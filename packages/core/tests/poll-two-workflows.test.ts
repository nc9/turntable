// Two poll entries for one repository and project (#549): `ci.yml` for pushes, pull requests and
// the merge queue, and `release.yml` for release tags. Each entry plans only its own workflow; the
// seen-set, the run cap and the checks are per (workflow, event, sha), and the project's
// concurrency cap is shared by the runs of both.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  claimNextAttempt,
  ensureLocalTenant,
  listRuns,
  openDatabase,
  setProjectSandboxSettings,
  type Db,
  type Scope,
} from "../src/db";
import * as s from "../src/db/schema";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import { type CheckRunBody, type CheckRunsApi } from "../src/checks/client";
import { setProjectChecksMode, bindRepo } from "../src/db";
import { GithubClient, Poller, pollConfigSchema, pollRepo } from "../src/poll";
import { isPrimaryEntry } from "../src/poll/config";
import { DispatchError } from "../src/poll/dispatch";
import { setIngestPolicy } from "../src/ops/policy-cli";
import { newTagCaches } from "../src/poll/ingest";
import { makeGithub, SHA } from "./github-stub";

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
  merge_group:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const RELEASE = `name: Release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
`;
/** A release workflow whose job has the same name as ci.yml's. */
const RELEASE_SAME_JOB = RELEASE.replace("publish:", "build:");

const CI_PATH = ".github/workflows/ci.yml";
const RELEASE_PATH = ".github/workflows/release.yml";

let db: Db;
let scope: Required<Scope>;
let now = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  now = 1_800_000_000_000;
});

const linear = (...shas: string[]) =>
  shas.map((sha, i) => ({ sha, parents: shas[i + 1] ? [shas[i + 1] as string] : [] }));

function world(
  o: { releaseYaml?: string; ciExtra?: object; releaseExtra?: object; ciYaml?: string } = {},
) {
  const gh = makeGithub("acme/web", CI_PATH);
  gh.state.files.set("*", CI);
  gh.state.history = linear(SHA("a"), SHA("b"), SHA("c"));
  // Creating v* tags is restricted by a ruleset, so a tag run is not held.
  gh.state.rulesets = [
    { id: 1, include: ["refs/tags/v*"], bypass: [{ actor_type: "RepositoryRole", actor_id: 5 }] },
  ];
  // The stub serves one workflow path; serve the release workflow from here.
  const fetch: typeof gh.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : ((input as Request).url ?? String(input)),
    );
    if (url.pathname === `/repos/acme/web/contents/${RELEASE_PATH}`) {
      gh.state.calls.push({ path: url.pathname + url.search, method: init?.method });
      return new Response(o.releaseYaml ?? RELEASE);
    }
    return gh.fetch(input, init);
  };
  const config = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: CI_PATH,
        defaultBranch: "main",
        mergeQueue: true,
        prMode: "allowlist",
        authors: ["octocat"],
        vars: { TURNTABLE_CI: "true" },
        maxRunsPerHour: 1000,
        maxWaitingRuns: 500,
        ...o.ciExtra,
      },
      {
        repo: "acme/web",
        workflow: RELEASE_PATH,
        defaultBranch: "main",
        tagRefs: ["refs/tags/v*"],
        prMode: "off",
        vars: { TURNTABLE_CI: "true" },
        maxRunsPerHour: 1000,
        maxWaitingRuns: 500,
        ...o.releaseExtra,
      },
    ],
  });
  const github = new GithubClient({ fetch, baseUrl: "https://api.github.com" });
  const tagCaches = newTagCaches();
  const pollEntry = (i: number) =>
    pollRepo(
      { db, github, provider: "docker", now: () => now, tagCaches },
      // As the Poller does: the primary workflow is resolved from the whole config.
      {
        ...(config.repos[i] as (typeof config.repos)[number]),
        primary: isPrimaryEntry(config.repos, config.repos[i] as (typeof config.repos)[number]),
      },
    );
  /** One poll of each entry, in config order. */
  const pollBoth = async () => {
    await pollEntry(0);
    await pollEntry(1);
  };
  return { gh, fetch, config, github, pollEntry, pollBoth };
}

const runs = async () => await listRuns(db, scope, { limit: 1000 });
const byWorkflow = async (path: string) => (await runs()).filter((r) => r.workflowPath === path);

describe("one repository, two workflows", () => {
  test("a new tag runs release.yml only, with the tag ref, and no ci.yml run for the tag", async () => {
    const w = world();
    // An established ruleset: one poll with no tags first, then the tag appears.
    await w.pollBoth();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await w.pollBoth();
    const release = await byWorkflow(RELEASE_PATH);
    expect(release.map((r) => r.ref)).toEqual(["refs/tags/v1.2.3"]);
    expect(release[0]!.sha).toBe(SHA("a"));
    expect(JSON.parse(release[0]!.trust!).class).toBe("release");
    const ci = await byWorkflow(CI_PATH);
    expect(ci.filter((r) => r.ref.startsWith("refs/tags/"))).toEqual([]);
  });

  test("a branch push runs ci.yml only", async () => {
    const w = world();
    await w.pollBoth();
    const ci = await byWorkflow(CI_PATH);
    expect(ci.map((r) => [r.event, r.ref, r.sha])).toEqual([["push", "refs/heads/main", SHA("a")]]);
    expect(await byWorkflow(RELEASE_PATH)).toEqual([]);
  });

  test("polling twice ingests each (workflow, event, sha) once", async () => {
    const w = world();
    await w.pollBoth();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await w.pollBoth();
    const before = (await runs()).map((r) => r.id).sort();
    expect(before).toHaveLength(2);
    for (let i = 0; i < 3; i++) {
      now += 61_000;
      await w.pollBoth();
    }
    expect((await runs()).map((r) => r.id).sort()).toEqual(before);
    const keys = (await runs()).map((r) => `${r.workflowPath} ${r.event} ${r.sha}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("poll_seen is keyed per workflow", async () => {
    const w = world();
    await w.pollBoth();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await w.pollBoth();
    const rows = await db.run((h) => h.orm.select().from(s.pollSeen));
    const keys = rows.map((r) => [r.repo, r.workflowPath, r.event, r.sha].join("|")).sort();
    const sha = SHA("a");
    // Everything the poller remembers names its workflow: the pushes, the tag, and the markers.
    expect(keys).toEqual(
      [
        `acme/web|${CI_PATH}|pr-mode-enabled|since`,
        `acme/web|${CI_PATH}|push|${sha}`,
        `acme/web|${RELEASE_PATH}|push|${sha}`,
        `acme/web|${RELEASE_PATH}|tag-listed:v1.2.3|first`,
        `acme/web|${RELEASE_PATH}|tag-protected:refs/tags/v*|since`,
        `acme/web|${RELEASE_PATH}|tag:v1.2.3|${sha}`,
      ].sort(),
    );
  });

  test("the project's max_concurrent cap is shared by the runs of both workflows", async () => {
    const w = world();
    await w.pollBoth();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await w.pollBoth();
    const jobs = (await runs()).length;
    expect(jobs).toBe(2);
    await setProjectSandboxSettings(db, scope, { maxConcurrent: 1 });
    const claim = () =>
      claimNextAttempt(db, { owner: "w", leaseMs: 10_000, now, globalCap: 50, perOrgCap: 10 });
    const first = await claim();
    expect(first).toBeDefined();
    // A second attempt, from the OTHER workflow, is held: the one slot is shared.
    expect(await claim()).toBeUndefined();
    const workflows = new Set<string>();
    workflows.add(first!.run.workflowPath);
    // Raising the cap to two lets the other workflow's attempt through.
    await setProjectSandboxSettings(db, scope, { maxConcurrent: 2 });
    const second = await claim();
    expect(second).toBeDefined();
    workflows.add(second!.run.workflowPath);
    expect([...workflows].sort()).toEqual([CI_PATH, RELEASE_PATH]);
  });
});

describe("checks", () => {
  function fakeApi() {
    const runsById = new Map<string, CheckRunBody>();
    let next = 1;
    const api: CheckRunsApi = {
      async create(_t, _repo, body) {
        const id = String(next++);
        runsById.set(id, { ...body });
        return id;
      },
      async update(_t, _repo, id, body) {
        runsById.set(id, { ...runsById.get(id), ...body });
      },
      async findByExternalId(_t, _repo, _sha, name, externalId) {
        for (const [id, b] of runsById)
          if (b.external_id === externalId && b.name === name) return id;
        return undefined;
      },
    };
    return { api, runsById };
  }
  const auth: TokenMinter = { mint: async () => ({ token: "stub-installation-token" }) };

  async function postChecks(mode: "shadow" | "live", releaseYaml: string) {
    const w = world({ releaseYaml });
    await bindRepo(db, scope, {
      forge: "github",
      owner: "acme",
      repo: "web",
      installationId: "9001",
    });
    await setProjectChecksMode(db, scope, mode);
    await w.pollBoth();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await w.pollBoth();
    const { api, runsById } = fakeApi();
    const rep = new CheckReporter({
      db,
      auth,
      api,
      publicUrl: "https://ci.example.com",
      sleep: async () => {},
    });
    for (let i = 0; i < 2; i++) {
      const c = await claimNextAttempt(db, {
        owner: "w",
        leaseMs: 10_000,
        now,
        globalCap: 50,
        perOrgCap: 10,
      });
      expect(c).toBeDefined();
      rep.started(c!);
      rep.finished(c!, { state: "success", reason: "" });
    }
    await rep.idle();
    return [...runsById.values()];
  }

  for (const mode of ["shadow", "live"] as const) {
    test(`${mode}: each workflow's jobs post their own check names`, async () => {
      const posted = await postChecks(mode, RELEASE);
      const prefix = mode === "shadow" ? "shadow" : "turntable";
      expect(posted.map((b) => b.name).sort()).toEqual([
        `${prefix} / Release / publish`,
        `${prefix} / build`,
      ]);
      expect(new Set(posted.map((b) => b.external_id)).size).toBe(2);
    });
  }

  test("a job of the same name in both workflows posts two DISTINCT contexts; the primary keeps the plain name", async () => {
    const posted = await postChecks("live", RELEASE_SAME_JOB);
    expect(posted).toHaveLength(2);
    expect(posted.map((b) => b.name).sort()).toEqual([
      "turntable / Release / build",
      "turntable / build",
    ]);
    expect(posted.map((b) => b.head_sha)).toEqual([SHA("a"), SHA("a")]);
    expect(new Set(posted.map((b) => b.external_id)).size).toBe(2);
    // Neither result overwrote the other: both are completed with their own conclusion.
    expect(posted.every((b) => b.status === "completed" && b.conclusion === "success")).toBe(true);
  });

  test("a workflow name is rendered inertly (no markup)", async () => {
    const posted = await postChecks(
      "live",
      RELEASE_SAME_JOB.replace("name: Release", "name: '`x`'"),
    );
    expect(posted.map((b) => b.name).sort()).toEqual([
      "turntable / build",
      "turntable / x / build",
    ]);
  });

  test("a workflow with no name uses its file name (shadow mode too)", async () => {
    const bare = await postChecks("shadow", RELEASE_SAME_JOB.replace("name: Release\n", ""));
    expect(bare.map((b) => b.name).sort()).toEqual(["shadow / build", "shadow / release / build"]);
  });
});

describe("which entry is primary", () => {
  const entry = (workflow: string, extra: object = {}) => ({
    repo: "acme/web",
    workflow,
    defaultBranch: "main",
    ...extra,
  });
  const parse = (repos: object[]) => pollConfigSchema.parse({ allowUnauthenticated: true, repos });

  test("a single entry is primary; with none marked the first is; a marked one wins", () => {
    const one = parse([entry(CI_PATH)]);
    expect(isPrimaryEntry(one.repos, one.repos[0]!)).toBe(true);
    const two = parse([entry(CI_PATH), entry(RELEASE_PATH)]);
    expect(two.repos.map((r) => isPrimaryEntry(two.repos, r))).toEqual([true, false]);
    const marked = parse([entry(CI_PATH), entry(RELEASE_PATH, { primary: true })]);
    expect(marked.repos.map((r) => isPrimaryEntry(marked.repos, r))).toEqual([false, true]);
  });

  test("two entries marked primary are refused at load, with a reason", () => {
    expect(() =>
      parse([entry(CI_PATH, { primary: true }), entry(RELEASE_PATH, { primary: true })]),
    ).toThrow(/marked primary/);
  });
});

describe("dispatch picks the entry of the dispatched workflow", () => {
  const DISPATCHABLE = (y: string) => y.replace("on:\n", "on:\n  workflow_dispatch:\n");
  const planOf = async (runId: string) => {
    const [row] = await db.run((h) => h.orm.select().from(s.runs));
    void row;
    const all = await db.run((h) => h.orm.select().from(s.runs));
    return JSON.parse(all.find((r) => r.id === runId)!.plan!) as {
      vars: Record<string, string>;
      trust: string;
      checkScope?: string;
    };
  };
  function dispatchWorld() {
    const w = world({
      releaseYaml: DISPATCHABLE(RELEASE),
      ciExtra: { vars: { WHICH: "ci" } },
      releaseExtra: { vars: { WHICH: "release" }, protectedRefs: ["refs/heads/rel/**"] },
    });
    w.gh.state.files.set("*", DISPATCHABLE(CI));
    w.gh.state.branches.set("rel/x", SHA("b"));
    const p = new Poller({ db, config: w.config, fetch: w.fetch, now: () => now });
    const go = (workflow: string, ref = "main") =>
      p.dispatch(scope, "acme/web", {
        workflow,
        ref,
        inputs: {},
        actor: "tester",
        role: "operator",
      });
    return { w, p, go };
  }

  test("release.yml uses the release entry's vars and rules; ci.yml uses ci's", async () => {
    const { go } = dispatchWorld();
    const rel = await go(RELEASE_PATH, "rel/x");
    expect((await planOf(rel.runId)).vars).toEqual({ WHICH: "release" });
    expect(rel.trustClass).toBe("protected");
    expect((await planOf(rel.runId)).checkScope).toBe("Release");
    const ci = await go(CI_PATH, "rel/x");
    expect((await planOf(ci.runId)).vars).toEqual({ WHICH: "ci" });
    // ci's entry does not protect rel/**
    expect(ci.trustClass).toBe("trusted_pr");
    expect((await planOf(ci.runId)).checkScope).toBeUndefined();
  });

  test("a workflow with no poll entry is refused with the reason", async () => {
    const { go } = dispatchWorld();
    const err = await go(".github/workflows/other.yml").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect((err as Error).message).toBe(
      "no poll entry for .github/workflows/other.yml in acme/web",
    );
  });
});

describe("the Poller serves both entries", () => {
  test("a poller configured with both entries ingests the tag into release.yml and the push into ci.yml", async () => {
    const w = world();
    const p = new Poller({ db, config: w.config, fetch: w.fetch, now: () => now });
    await p.pollAll();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    await p.pollAll();
    expect((await byWorkflow(CI_PATH)).map((r) => r.ref)).toEqual(["refs/heads/main"]);
    expect((await byWorkflow(RELEASE_PATH)).map((r) => r.ref)).toEqual(["refs/tags/v1.2.3"]);
  });
});

describe("after a GitHub App installation binds the repository", () => {
  const bind = () =>
    bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web", installationId: "9001" });

  test("a webhook wakes the poller by repo name, and one poll of the repo runs BOTH static entries", async () => {
    const w = world();
    await bind();
    const p = new Poller({
      db,
      config: w.config,
      fetch: w.fetch,
      now: () => now,
      bindings: true,
    });
    await p.pollAll();
    now += 1_000;
    w.gh.state.tags.set("v1.2.3", { sha: SHA("a") });
    p.start();
    try {
      // what the webhook's onRepoEvent does: nudge(repo)
      expect(p.nudge("acme/web")).toBe(true);
      for (let i = 0; i < 100 && (await byWorkflow(RELEASE_PATH)).length === 0; i++)
        await new Promise((r) => setTimeout(r, 100));
    } finally {
      p.stop();
    }
    expect((await byWorkflow(RELEASE_PATH)).map((r) => r.ref)).toEqual(["refs/tags/v1.2.3"]);
    expect((await byWorkflow(CI_PATH)).map((r) => r.ref)).toEqual(["refs/heads/main"]);
  });

  test("a static entry wins over the binding's own ingest settings: the binding adds no third workflow", async () => {
    const w = world();
    await bind();
    await setIngestPolicy(db, "local", "local", "on", {
      defaultBranch: "main",
      workflow: ".github/workflows/other.yml",
    });
    const p = new Poller({ db, config: w.config, fetch: w.fetch, now: () => now, bindings: true });
    await p.pollAll();
    expect(new Set((await runs()).map((r) => r.workflowPath))).toEqual(new Set([CI_PATH]));
  });

  test("a binding with ingest settings and no static entry ingests ONE workflow, the one in its settings", async () => {
    const w = world();
    await bind();
    await setIngestPolicy(db, "local", "local", "on", {
      defaultBranch: "main",
      workflow: CI_PATH,
      tagRefs: ["refs/tags/v*"],
    });
    const other = pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [{ repo: "static/other", workflow: CI_PATH, defaultBranch: "main" }],
    });
    const p = new Poller({ db, config: other, fetch: w.fetch, now: () => now, bindings: true });
    await p.pollAll();
    // ci.yml (its single workflow) is ingested; release.yml is never read for this repo.
    expect(new Set((await runs()).map((r) => r.workflowPath))).toEqual(new Set([CI_PATH]));
    expect(w.gh.state.calls.some((c) => c.path.includes("release.yml"))).toBe(false);
  });
});
