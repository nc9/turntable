// An installation that drops a polled-then-adopted repo unbinds it; the next poll binds it again.
// The rebind must land on the SAME project (its id, settings and run history kept), through the
// poll config's project, and leave the binding with no installation so no check is posted.
import { afterAll, describe, expect, test } from "bun:test";
import { openPostgres } from "../src/db/pg";
import { testDb } from "../src/db/dialect";
import {
  createProject,
  type Db,
  getProjectSandboxSettings,
  listProjects,
  listRepos,
  listRuns,
  openDatabase,
  setProjectSandboxSettings,
} from "../src/db";
import { syncInstallation } from "../src/github/installations";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { fakeFacts, inst, repo, setup } from "./github-helpers";

const SHA = "a".repeat(40);
const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

const fetchStub = async (url: string): Promise<Response> => {
  const u = new URL(url);
  if (/^\/repos\/acme\/api\/commits\/(main|[0-9a-f]{40})$/.test(u.pathname)) {
    return Response.json({
      sha: SHA,
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

const cfg = pollConfigSchema.parse({
  allowUnauthenticated: true,
  repos: [
    {
      repo: "acme/api",
      workflow: ".github/workflows/ci.yml",
      defaultBranch: "main",
      org: "acme",
      project: "poll",
    },
  ],
}).repos[0]!;

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_rebind_${process.pid}` }
    : { pglite: true };
};

const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
});

describe.each(dialects)("poll rebind after an installation removes the repo (%s)", (_n, open) => {
  const fresh = () =>
    setup("42", () => {
      const db = open();
      opened.push(db);
      return db;
    });
  const clientDeps = (db: Db) => ({
    db,
    github: new GithubClient({ fetch: fetchStub, baseUrl: "https://api.github.com" }),
    provider: "docker",
    now: () => 1_800_000_000_000,
  });

  test("the rebind keeps the same project, its settings and its runs, with no installation", async () => {
    const { db, org } = await fresh();
    const deps = clientDeps(db);

    // 1. A poll entry binds acme/api into project P (the project exists; the poller never makes one).
    const project = await createProject(db, { orgId: org.id }, { slug: "poll", name: "Poll" });
    const scope = { orgId: org.id, projectId: project.id };
    await pollRepo(deps, cfg);
    expect(await listRepos(db, scope)).toMatchObject([{ repo: "api", installationId: null }]);

    // 2. P gets settings.
    await setProjectSandboxSettings(db, scope, { maxConcurrent: 3, untrustedRunApproval: "human" });
    const settings = await getProjectSandboxSettings(db, scope);
    expect(settings).toMatchObject({ maxConcurrent: 3, untrustedRunApproval: "human" });

    // 3. The installation sync adopts the binding.
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    expect(await syncInstallation(db, f.facts, "100")).toMatchObject({ adopted: ["acme/api"] });
    expect((await listRepos(db, scope))[0]).toMatchObject({ installationId: "100" });
    const runsBefore = (await listRuns(db, scope)).map((r) => r.id);
    expect(runsBefore).toHaveLength(1);

    // 4. The installation removes the repo, which unbinds it.
    f.repos.set("100", []);
    expect((await syncInstallation(db, f.facts, "100")).unbound).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toHaveLength(0);

    // 5. The next poll binds it into the SAME project.
    await pollRepo(deps, cfg);
    const rebound = await listRepos(db, scope);
    expect(rebound).toHaveLength(1);
    expect(rebound[0]).toMatchObject({ owner: "acme", repo: "api", projectId: project.id });
    expect((await listProjects(db, { orgId: org.id })).map((p) => p.id)).toEqual([project.id]);
    expect(await getProjectSandboxSettings(db, scope)).toEqual(settings);
    expect((await listRuns(db, scope)).map((r) => r.id)).toEqual(runsBefore);

    // 6. No installation again, so the reporter has nothing to post through.
    expect(rebound[0]!.installationId).toBeNull();
  });

  test("a poll entry naming a missing project binds nothing and creates no project", async () => {
    const { db, org } = await fresh();
    await expect(pollRepo(clientDeps(db), cfg)).rejects.toThrow(/no project poll/);
    expect(await listProjects(db, { orgId: org.id })).toHaveLength(0);
  });
});
