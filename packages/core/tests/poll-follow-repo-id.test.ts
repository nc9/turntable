// A repo renamed or transferred keeps its project: the binding follows it by forge repo id, the
// static poll entry follows the binding, and the old installation losing access detaches nothing
// (#428). Also the first poll after a start reads the installations first (#568).
import { expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  listAudit,
  listProjects,
  listRepos,
  listRuns,
  moveRepoBinding,
  openDatabase,
  type Db,
} from "../src/db";
import { syncInstallation } from "../src/github/installations";
import { Poller, pollConfigSchema, resetIngestStatus } from "../src/poll";
import { fakeFacts, inst, repo, setup } from "./github-helpers";
import { makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const ID = "77";
const tokenFor = (installation: string): string => ["inst", "tok", installation].join("_");

async function world() {
  resetIngestStatus();
  const w = await setup("42", () => openDatabase(":memory:"));
  const project = await createProject(
    w.db,
    { orgId: w.org.id },
    { slug: "proj", name: "proj", maxConcurrent: 3 },
  );
  const scope = { orgId: w.org.id, projectId: project.id };
  await bindRepo(w.db, scope, {
    forge: "github",
    owner: "aco",
    repo: "x",
    installationId: "100",
    forgeRepoId: ID,
  });
  const f = fakeFacts();
  f.installations.set(
    "100",
    inst("100", "42", { account: { login: "aco", id: "1", type: "User" } }),
  );
  f.repos.set("100", [repo(ID, "x", "aco")]);
  await syncInstallation(w.db, f.facts, "100");
  return { ...w, project, scope, f };
}

/** Fake GitHub: the repo lives at `slug`; the old slug redirects to it (answers its id and name). */
function github(w: { db: Db }, slugs: { now: string; old?: string }) {
  const gh = makeGithub(slugs.now);
  gh.state.files.set("*", WORKFLOW);
  const auths: { path: string; auth: string }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    if (path.startsWith("/repos/")) {
      auths.push({ path, auth: new Headers(init?.headers).get("authorization") ?? "" });
    }
    if (path === `/repos/${slugs.now}` || path === `/repos/${slugs.old}`) {
      return Response.json({ id: Number(ID), full_name: slugs.now, default_branch: "main" });
    }
    return gh.fetch(url, init);
  };
  return { gh, auths, fetch, db: w.db };
}

function poller(
  db: Db,
  fetch: (u: string, i?: RequestInit) => Promise<Response>,
  mints: string[],
  entry = "aco/x",
) {
  return new Poller({
    db,
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        {
          repo: entry,
          org: "acme",
          project: "proj",
          workflow: ".github/workflows/ci.yml",
          defaultBranch: "main",
        },
      ],
    }),
    auth: {
      async mint(id) {
        mints.push(id);
        return { token: tokenFor(id) };
      },
    },
    fetch,
    log: () => {},
    bindings: true,
  });
}

/** Transfer: the repo moves to account bco, whose installation 200 is claimed into `orgId`. */
async function transfer(w: Awaited<ReturnType<typeof world>>, claimedBy: string) {
  w.f.repos.set("100", []);
  w.f.installations.set(
    "200",
    inst("200", "42", { account: { login: "bco", id: "2", type: "Organization" } }),
  );
  w.f.repos.set("200", [repo(ID, "x", "bco")]);
  return syncInstallation(w.db, w.f.facts, "200", { claimMode: true, claimedBy });
}

test("a transfer keeps the project; the poll entry follows the binding with the new installation", async () => {
  const w = await world();
  const before = github(w, { now: "aco/x" });
  await poller(w.db, before.fetch, []).pollAll();
  expect(await listRuns(w.db, w.scope)).toHaveLength(1);
  const projects = await listProjects(w.db, { orgId: w.org.id });

  const r = await transfer(w, w.org.id);
  expect(r).toMatchObject({ followed: ["bco/x"], conflicts: [], bound: [] });
  // The old installation no longer lists it: its sync detaches nothing that moved.
  expect(await syncInstallation(w.db, w.f.facts, "100")).toMatchObject({ unbound: [] });
  expect(await listRepos(w.db, w.scope)).toMatchObject([
    { owner: "bco", repo: "x", installationId: "200", forgeRepoId: ID },
  ]);
  expect(await listProjects(w.db, { orgId: w.org.id })).toEqual(projects);

  // The restarted poller still has the entry `aco/x`.
  const after = github(w, { now: "bco/x", old: "aco/x" });
  const mints: string[] = [];
  const p = poller(w.db, after.fetch, mints);
  await p.pollAll();
  const { ingestStatus } = await import("../src/poll");
  const st = ingestStatus.repos.get("aco/x")!;
  expect(st).toMatchObject({ lastOutcome: "ok", lastError: null, effectiveRepo: "bco/x" });
  expect(await listRuns(w.db, w.scope)).toHaveLength(1); // the same head is not run again
  expect(mints).toContain("200");
  const polled = after.auths.filter((a) => a.path.startsWith("/repos/bco/x/commits"));
  expect(polled.length).toBeGreaterThan(0);
  for (const a of polled) expect(a.auth).toBe(`Bearer ${tokenFor("200")}`);
  expect(after.gh.state.calls.some((c) => c.path.startsWith("/repos/aco/x"))).toBe(false);
  const follow = (await listAudit(w.db, { orgId: w.org.id })).filter(
    (a) => a.op === "follow_repo_binding",
  );
  expect(follow).toHaveLength(1);
});

test("a transfer into a different org is not followed; the operator path still works", async () => {
  const w = await world();
  const other = await createOrg(w.db, { slug: "other", name: "Other" });
  const r = await transfer(w, other.id);
  expect(r).toMatchObject({ followed: [], conflicts: ["bco/x"], reachable: [], bound: [] });
  expect(await listRepos(w.db, w.scope)).toMatchObject([
    { owner: "aco", repo: "x", installationId: "100" },
  ]);
  expect(await listProjects(w.db, { orgId: other.id })).toEqual([]);
  const refused = (await listAudit(w.db, { orgId: w.org.id })).filter(
    (a) => a.op === "follow_repo_binding",
  );
  expect(refused).toMatchObject([{ outcome: "error:other_org" }]);
  const [binding] = await listRepos(w.db, w.scope);
  const target = await createProject(w.db, { orgId: other.id }, { slug: "p", name: "p" });
  expect(await moveRepoBinding(w.db, binding!.id, { orgId: other.id, projectId: target.id })).toBe(
    true,
  );
});

test("a rename within one account updates the slug in place", async () => {
  const w = await world();
  w.f.repos.set("100", [repo(ID, "y", "aco")]);
  const r = await syncInstallation(w.db, w.f.facts, "100");
  expect(r).toMatchObject({ followed: ["aco/y"], reachable: [], unbound: [] });
  expect(await listRepos(w.db, w.scope)).toMatchObject([
    { owner: "aco", repo: "y", installationId: "100" },
  ]);
  expect(await listProjects(w.db, { orgId: w.org.id })).toHaveLength(1);
});

test("a re-created old name with another repo id does not take the binding", async () => {
  const w = await world();
  w.f.repos.set("100", [repo("999", "x", "aco")]);
  const r = await syncInstallation(w.db, w.f.facts, "100");
  expect(r.followed).toEqual([]);
  // The old repo is gone from the installation (unbound as before); the new one never inherits it.
  expect(r.unbound).toEqual(["aco/x"]);
  expect(await listRepos(w.db, w.scope)).toEqual([]);
});

test("the first poll after a start already uses the installation token (#568)", async () => {
  const w = await world();
  const g = github(w, { now: "aco/x" });
  const mints: string[] = [];
  const p = poller(w.db, g.fetch, mints);
  p.start();
  for (let i = 0; i < 100 && g.auths.length === 0; i++) await Bun.sleep(20);
  p.stop();
  expect(g.auths.length).toBeGreaterThan(0);
  expect(g.auths[0]!.auth).toBe(`Bearer ${tokenFor("100")}`);
  for (const a of g.auths) expect(a.auth).toBe(`Bearer ${tokenFor("100")}`);
});
