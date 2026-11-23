// Instance op move_repo_binding (#370): a polled repo moves from one org's project to another's.
// REST only, instance administrator only, audited in the system chain and both orgs' chains. The
// poller follows the move (seen markers travel with the repo) and skips a stale entry quietly.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "bun:test";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import { systemOrgId } from "../src/audit/failures";
import {
  bindRepo,
  createAttempt,
  createJob,
  countPolledSince,
  createOrg,
  createPolledRun,
  createProject,
  createRun,
  type Db,
  listAudit,
  listRepos,
  listRuns,
  schema,
  setProjectChecksMode,
  upsertInstallation,
} from "../src/db";
import { syncInstallation } from "../src/github/installations";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { ingestStatus, resetIngestStatus } from "../src/poll/status";
import { fakeFacts, inst, repo, setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

let head = "a".repeat(40);
let fetched = 0;
const fetchStub = async (url: string): Promise<Response> => {
  fetched += 1;
  const u = new URL(url);
  if (/^\/repos\/acme\/api\/commits\/(main|[0-9a-f]{40})$/.test(u.pathname)) {
    return Response.json({
      sha: head,
      commit: { message: "feat: x" },
      author: { login: "octocat" },
    });
  }
  if (u.pathname === "/repos/acme/api/branches/main") return Response.json({ protected: true });
  if (u.pathname === "/repos/acme/api/contents/.github/workflows/ci.yml") {
    return new Response(WORKFLOW);
  }
  return new Response("unexpected", { status: 500 });
};

const entry = (org: string, project: string) =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/api",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        org,
        project,
      },
    ],
  }).repos[0]!;

const REFUSED = "that binding cannot be moved to that org and project";

let db: Db;
let env: DispatchEnv;
let secret: string;
let orgA: { id: string; slug: string };
let orgB: { id: string; slug: string };
let scopeA: { orgId: string; projectId: string };
let scopeB: { orgId: string; projectId: string };
let projectA: { id: string };
let projectB: { id: string };
let logs: string[];

const deps = () => ({
  db,
  github: new GithubClient({ fetch: fetchStub, baseUrl: "https://api.github.com" }),
  provider: "docker",
  now: () => 1_800_000_000_000,
  log: (m: string) => logs.push(m),
});

const move = (over: Record<string, unknown> = {}) =>
  dispatch(env, { kind: "bearer", token: secret }, "move_repo_binding", {
    owner: "acme",
    repo: "api",
    to_org: "beta",
    to_project: "web",
    ...over,
  });

beforeEach(async () => {
  head = "a".repeat(40);
  fetched = 0;
  logs = [];
  resetIngestStatus();
  const w = await setup();
  db = w.db;
  orgA = w.org;
  orgB = await createOrg(db, { slug: "beta", name: "Beta" });
  projectA = await createProject(db, { orgId: orgA.id }, { slug: "poll", name: "Poll" });
  projectB = await createProject(db, { orgId: orgB.id }, { slug: "web", name: "Web" });
  scopeA = { orgId: orgA.id, projectId: projectA.id };
  scopeB = { orgId: orgB.id, projectId: projectB.id };
  env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => 1_700_000_000_000 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});

describe("move_repo_binding", () => {
  test("moves the binding, keeps the installation, audits all three chains, names stale entries", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    ingestStatus.repos.set("acme/api", {
      repo: "acme/api",
      org: "acme",
      project: "poll",
      lastPollAt: null,
      lastOutcome: null,
      lastError: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      runsCreated: 0,
      authMode: null,
      rateLimit: undefined,
    });
    const r = await move();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toMatchObject({
      repo: "acme/api",
      installation_id: null,
      from: { org: "acme", project: "poll" },
      to: { org: "beta", project: "web" },
      poll_entries_to_update: [{ repo: "acme/api", org: "acme", project: "poll" }],
    });
    expect(await listRepos(db, scopeA)).toHaveLength(0);
    expect(await listRepos(db, scopeB)).toMatchObject([{ owner: "acme", repo: "api" }]);

    const ids = {
      from_org_id: orgA.id,
      from_project_id: projectA.id,
      to_org_id: orgB.id,
      to_project_id: projectB.id,
    };
    const chains = [{ orgId: await systemOrgId(db) }, { orgId: orgA.id }, { orgId: orgB.id }];
    for (const c of chains) {
      const rows = (await listAudit(db, c, { limit: 50 })).filter(
        (x) => x.op === "move_repo_binding",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ principalKind: "instance", outcome: "ok" });
      if (c.orgId !== (await systemOrgId(db))) {
        expect(JSON.parse(rows[0]!.input)).toMatchObject(ids);
      }
    }
    expect(JSON.stringify(await listAudit(db, { orgId: orgB.id }, { limit: 50 }))).not.toContain(
      secret,
    );
  });

  test("an entry already updated is not listed", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    ingestStatus.repos.set("acme/api", {
      repo: "acme/api",
      org: "beta",
      project: "web",
      lastPollAt: null,
      lastOutcome: null,
      lastError: null,
      nextPollAt: null,
      consecutiveFailures: 0,
      runsCreated: 0,
      authMode: null,
      rateLimit: undefined,
    });
    const r = await move();
    expect(
      r.ok && (r.output as { poll_entries_to_update: unknown }).poll_entries_to_update,
    ).toEqual([]);
  });

  test("poll dedupe follows the repo: the same head adds no run, a new sha adds exactly one", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    expect(await listRuns(db, scopeA)).toHaveLength(1);
    expect((await move()).ok).toBe(true);

    const same = await pollRepo(deps(), entry("beta", "web"));
    expect(same.created).toEqual([]);
    expect(await listRuns(db, scopeB)).toHaveLength(0);

    head = "b".repeat(40);
    const next = await pollRepo(deps(), entry("beta", "web"));
    expect(next.created).toHaveLength(1);
    expect(await listRuns(db, scopeB)).toHaveLength(1);
    expect(await listRuns(db, scopeA)).toHaveLength(1);
    // Polling again at the new head adds nothing.
    expect((await pollRepo(deps(), entry("beta", "web"))).created).toEqual([]);
  });

  test("a moved marker carries no run id: the new org's cap reads nothing of the old org", async () => {
    await pollRepo(deps(), entry("acme", "poll")); // binds the repo, one push marker
    const seed = await createPolledRun(db, scopeA, {
      repo: "acme/api",
      run: {
        workflowPath: ".github/workflows/ci.yml",
        event: "pull_request",
        ref: "refs/pull/1/merge",
        sha: "c".repeat(40),
        trust: JSON.stringify({ class: "trusted_pr" }),
      },
      jobs: [],
      provider: "docker",
      now: 1_800_000_000_000,
    });
    expect(seed).toBeDefined();
    expect(await countPolledSince(db, scopeA, "acme/api", 0)).toBe(2);
    expect((await move()).ok).toBe(true);
    // The old run is not counted for the new org (the marker has no matching run), and the
    // old org's own rows are untouched.
    // Only the push marker counts for the new org; the old org's PR run would have added one.
    expect(await countPolledSince(db, scopeB, "acme/api", 0)).toBe(1);
    expect(await countPolledSince(db, scopeA, "acme/api", 0)).toBe(2);
    const moved = await db.run((h) =>
      h.orm.select().from(schema.pollSeen).where(eq(schema.pollSeen.orgId, orgB.id)),
    );
    expect(moved.length).toBe(2);
    expect(moved.every((r) => r.runId === "moved")).toBe(true);

    const before = (await listRuns(db, scopeB)).length;
    expect((await pollRepo(deps(), entry("beta", "web"))).created).toEqual([]);
    expect(await listRuns(db, scopeB)).toHaveLength(before);
    head = "d".repeat(40);
    expect((await pollRepo(deps(), entry("beta", "web"))).created).toHaveLength(1);
  });

  test("a stale poll entry is skipped with one warning per poll: no bind, no crash, no GitHub call", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    expect((await move()).ok).toBe(true);
    fetched = 0;
    logs = [];
    for (let n = 1; n <= 3; n++) {
      const r = await pollRepo(deps(), entry("acme", "poll"));
      expect(r.created).toEqual([]);
      expect(r.skipped).toMatch(/bound to another project/);
      expect(logs).toHaveLength(n);
    }
    expect(fetched).toBe(0);
    expect(await listRepos(db, scopeA)).toHaveLength(0);
    expect(await listRepos(db, scopeB)).toHaveLength(1);
  });

  test("the old project's history and in-flight attempts stay, readable in the old org only", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    const [run] = await listRuns(db, scopeA);
    const job = (await createJob(db, scopeA, { runId: run!.id, jobKey: "extra", name: "extra" }))!;
    const attempt = (await createAttempt(db, scopeA, { jobId: job.id, provider: "fake" }))!;
    expect((await move()).ok).toBe(true);
    expect((await listRuns(db, scopeA)).map((x) => x.id)).toEqual([run!.id]);
    expect(await listRuns(db, scopeB)).toEqual([]);
    expect(attempt.projectId).toBe(projectA.id);
    expect(attempt.orgId).toBe(orgA.id);
  });

  test("an installation claimed by the target org adopts the moved binding and the reporter mints", async () => {
    await pollRepo(deps(), entry("acme", "poll"));
    expect((await move()).ok).toBe(true);
    await pollRepo(deps(), entry("beta", "web"));
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    const r = await syncInstallation(db, f.facts, "100", { claimedBy: orgB.id, claimMode: true });
    expect(r).toMatchObject({ adopted: ["acme/api"], conflicts: [] });
    expect(await listRepos(db, scopeB)).toMatchObject([
      { installationId: "100", forgeRepoId: "1" },
    ]);

    await setProjectChecksMode(db, scopeB, "shadow");
    const minted: string[] = [];
    const auth: TokenMinter = {
      async mint(installationId) {
        minted.push(installationId);
        return { token: "stub-installation-token" };
      },
    };
    const rep = new CheckReporter({
      db,
      auth,
      api: {
        async create() {
          return "7";
        },
        async update() {},
        async findByExternalId() {
          return undefined;
        },
      },
      publicUrl: "https://ci.example.com",
      sleep: async () => {},
    });
    const run = await createRun(db, scopeB, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: "c".repeat(40),
      repo: "acme/api",
    });
    const job = (await createJob(db, scopeB, { runId: run.id, jobKey: "build", name: "build" }))!;
    const attempt = (await createAttempt(db, scopeB, { jobId: job.id, provider: "fake" }))!;
    rep.started({ attempt, job, run, scope: scopeB } as never);
    await rep.idle();
    expect(minted).toEqual(["100"]);
  });
});

describe("move_repo_binding refusals", () => {
  const installationOf = (orgId: string) =>
    upsertInstallation(
      db,
      { orgId },
      {
        installationId: "100",
        appId: "42",
        accountLogin: "acme",
        accountId: "7",
        accountType: "Organization",
        repositorySelection: "selected",
        status: "active",
      },
    );

  test("an installation mapped to another org: refused with one uniform message, nothing moved", async () => {
    await bindRepo(db, scopeA, {
      forge: "github",
      owner: "acme",
      repo: "api",
      installationId: "100",
      forgeRepoId: "1",
    });
    await installationOf(orgA.id);
    const r = await move();
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toBe(REFUSED);
    expect(await listRepos(db, scopeA)).toHaveLength(1);
    expect(await listRepos(db, scopeB)).toHaveLength(0);
    // Same message for a mismatched repo id.
    await installationOf(orgB.id).catch(() => {});
    const mismatch = await move({ forge_repo_id: "2" });
    expect(!mismatch.ok && mismatch.error.message).toBe(REFUSED);
  });

  test("an installation mapped to the target org moves with the binding", async () => {
    await installationOf(orgB.id);
    await bindRepo(db, scopeA, {
      forge: "github",
      owner: "acme",
      repo: "api",
      installationId: "100",
      forgeRepoId: "1",
    });
    const r = await move({ forge_repo_id: "1" });
    expect(r.ok && (r.output as { installation_id: unknown }).installation_id).toBe("100");
    expect(await listRepos(db, scopeB)).toMatchObject([{ installationId: "100" }]);
  });

  test("a missing target project, org, binding, and a no-op move are refused", async () => {
    await bindRepo(db, scopeA, { forge: "github", owner: "acme", repo: "api" });
    for (const over of [{ to_project: "nope" }, { to_org: "nope" }, { to_org: "_system" }]) {
      const r = await move(over);
      expect(!r.ok && r.error.code, JSON.stringify(over)).toBe("not_found");
    }
    // A project of another org is not found in the target org.
    await createProject(db, { orgId: orgA.id }, { slug: "only-a", name: "x" });
    expect((await move({ to_project: "only-a" })).ok).toBe(false);
    const gone = await move({ repo: "missing" });
    expect(!gone.ok && gone.error.code).toBe("not_found");
    const same = await move({ to_org: "acme", to_project: "poll" });
    expect(!same.ok && same.error.code).toBe("conflict");
    expect(await listRepos(db, scopeA)).toHaveLength(1);
  });

  test("an org token of any role is forbidden, and it is not an MCP tool", async () => {
    await bindRepo(db, scopeA, { forge: "github", owner: "acme", repo: "api" });
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const t = await mintToken(db, { orgId: orgA.id }, role);
      const r = await dispatch(env, { kind: "bearer", token: t.secret }, "move_repo_binding", {
        owner: "acme",
        repo: "api",
        to_org: "beta",
        to_project: "web",
      });
      expect(!r.ok && r.error.code, role).toBe("forbidden");
    }
    expect(await listRepos(db, scopeA)).toHaveLength(1);
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("move_repo_binding");
  });
});
