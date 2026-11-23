// A repo polled before the App was installed has a binding with no installation. The installation
// sync adopts it (same org, same project) so checks can be posted; anything else stays a conflict.
import { describe, expect, test } from "bun:test";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import {
  bindRepo,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  listAudit,
  listProjects,
  listRepos,
  setProjectChecksMode,
} from "../src/db";
import type { Claim } from "../src/db/repos";
import { syncInstallation } from "../src/github/installations";
import { fakeFacts, inst, repo, setup } from "./github-helpers";

async function polled(forgeRepoId?: string) {
  const w = await setup();
  const project = await createProject(w.db, { orgId: w.org.id }, { slug: "poll", name: "Poll" });
  const scope = { orgId: w.org.id, projectId: project.id };
  await bindRepo(w.db, scope, {
    forge: "github",
    owner: "acme",
    repo: "api",
    ...(forgeRepoId ? { forgeRepoId } : {}),
  });
  const f = fakeFacts();
  f.installations.set("100", inst("100"));
  f.repos.set("100", [repo("1", "api")]);
  return { ...w, project, scope, f };
}

describe("adopting a polled binding", () => {
  test("a same-org binding with no installation is adopted and keeps its project", async () => {
    const { db, org, project, scope, f } = await polled();
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ adopted: ["acme/api"], bound: [], conflicts: [] });
    expect(await listRepos(db, scope)).toMatchObject([
      { owner: "acme", repo: "api", installationId: "100", forgeRepoId: "1" },
    ]);
    expect((await listProjects(db, { orgId: org.id })).map((p) => p.id)).toEqual([project.id]);
    // A replay finds it ours: nothing more to do.
    expect(await syncInstallation(db, f.facts, "100")).toMatchObject({
      adopted: [],
      conflicts: [],
    });
  });

  test("the adoption is audited in the org chain", async () => {
    const { db, org, f } = await polled();
    await syncInstallation(db, f.facts, "100");
    const rows = (await listAudit(db, { orgId: org.id })).filter(
      (a) => a.op === "adopt_repo_binding",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "write", outcome: "ok" });
    expect(JSON.parse(rows[0]!.input)).toMatchObject({ repo: "acme/api", installationId: "100" });
  });

  test("a binding in another org is a conflict and untouched", async () => {
    const { db, f } = await polled();
    const other = await createOrg(db, { slug: "other", name: "Other" });
    const p = await createProject(db, { orgId: other.id }, { slug: "api", name: "api" });
    const os = { orgId: other.id, projectId: p.id };
    await bindRepo(db, os, { forge: "github", owner: "acme", repo: "web" });
    f.repos.set("100", [repo("2", "web")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ adopted: [], conflicts: ["acme/web"] });
    expect(await listRepos(db, os)).toMatchObject([{ installationId: null, forgeRepoId: null }]);
  });

  test("a binding of another installation is a conflict and untouched", async () => {
    const { db, scope, f } = await polled();
    await bindRepo(db, scope, {
      forge: "github",
      owner: "acme",
      repo: "web",
      installationId: "555",
      forgeRepoId: "2",
    });
    f.repos.set("100", [repo("2", "web")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ adopted: [], conflicts: ["acme/web"] });
    const web = (await listRepos(db, scope)).find((x) => x.repo === "web");
    expect(web).toMatchObject({ installationId: "555", forgeRepoId: "2" });
  });

  test("a binding whose forge repo id differs (renamed or recreated) is a conflict", async () => {
    const { db, scope, f } = await polled("999");
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ adopted: [], conflicts: ["acme/api"] });
    expect(await listRepos(db, scope)).toMatchObject([
      { installationId: null, forgeRepoId: "999" },
    ]);
  });

  test("a binding with a matching forge repo id is adopted", async () => {
    const { db, scope, f } = await polled("1");
    expect((await syncInstallation(db, f.facts, "100")).adopted).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toMatchObject([{ installationId: "100" }]);
  });

  test("removing the repo from the installation unbinds the adopted binding", async () => {
    // Documented rule: an adopted binding is an installation binding like any other. A static
    // poll entry that still names the repo binds it again on its next cycle.
    const { db, scope, f } = await polled();
    await syncInstallation(db, f.facts, "100");
    f.repos.set("100", []);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r.unbound).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toHaveLength(0);
  });

  test("end to end: the reporter mints a token for a polled repo only after the sync", async () => {
    const { db, project, scope, f } = await polled();
    await setProjectChecksMode(db, scope, "shadow");
    const minted: string[] = [];
    const auth: TokenMinter = {
      async mint(installationId) {
        minted.push(installationId);
        return { token: "stub-installation-token" };
      },
    };
    let created = 0;
    const rep = new CheckReporter({
      db,
      auth,
      api: {
        async create() {
          created += 1;
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
    const claim = async (): Promise<Claim> => {
      const run = await createRun(db, scope, {
        workflowPath: ".github/workflows/ci.yml",
        event: "push",
        ref: "refs/heads/main",
        sha: "a".repeat(40),
        repo: "acme/api",
      });
      const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
      const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
      return { attempt, job, run, scope };
    };

    rep.started(await claim());
    await rep.idle();
    expect(minted).toEqual([]);
    expect(created).toBe(0);

    await syncInstallation(db, f.facts, "100");
    expect((await listRepos(db, scope))[0]!.projectId).toBe(project.id);
    rep.started(await claim());
    await rep.idle();
    expect(minted).toEqual(["100"]);
    expect(created).toBe(1);
  });
});
