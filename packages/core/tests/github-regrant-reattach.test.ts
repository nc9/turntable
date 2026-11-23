// A repo bound only through an installation is unbound when the installation drops it. A later
// re-grant must re-attach it to the project that last held it (same org, same forge repo id),
// never by name alone and never across orgs. Run on both dialects with TURNTABLE_TEST_DB.
import { describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  getProjectSandboxSettings,
  listAudit,
  listProjects,
  listRepos,
  setProjectSandboxSettings,
} from "../src/db";
import { syncInstallation } from "../src/github/installations";
import { fakeFacts, inst, repo, setup } from "./github-helpers";

async function granted() {
  const w = await setup();
  const f = fakeFacts();
  f.installations.set("100", inst("100"));
  f.repos.set("100", [repo("1", "api")]);
  await syncInstallation(w.db, f.facts, "100");
  const [project] = await listProjects(w.db, { orgId: w.org.id });
  return { ...w, f, project: project! };
}

describe("re-grant re-attaches a binding-only repo", () => {
  test("grant, revoke, re-grant keeps the same project and its settings", async () => {
    const { db, org, f, project } = await granted();
    const scope = { orgId: org.id, projectId: project.id };
    await setProjectSandboxSettings(db, scope, { maxConcurrent: 3 });
    f.repos.set("100", []);
    expect((await syncInstallation(db, f.facts, "100")).unbound).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toHaveLength(0);

    f.repos.set("100", [repo("1", "api")]);
    expect(await syncInstallation(db, f.facts, "100")).toMatchObject({ bound: ["acme/api"] });
    expect((await listProjects(db, { orgId: org.id })).map((p) => p.id)).toEqual([project.id]);
    expect(await listRepos(db, scope)).toMatchObject([
      { owner: "acme", repo: "api", installationId: "100", forgeRepoId: "1" },
    ]);
    expect((await getProjectSandboxSettings(db, scope))?.maxConcurrent).toBe(3);
  });

  test("a deleted installation then a fresh grant re-attaches too", async () => {
    const { db, org, f, project } = await granted();
    f.installations.delete("100");
    await syncInstallation(db, f.facts, "100");
    f.installations.set("100", inst("100"));
    await syncInstallation(db, f.facts, "100");
    expect((await listProjects(db, { orgId: org.id })).map((p) => p.id)).toEqual([project.id]);
  });

  test("the same name with a different forge repo id is a new project", async () => {
    const { db, org, f, project } = await granted();
    f.repos.set("100", []);
    await syncInstallation(db, f.facts, "100");
    f.repos.set("100", [repo("9", "api")]);
    await syncInstallation(db, f.facts, "100");
    const projects = await listProjects(db, { orgId: org.id });
    expect(projects).toHaveLength(2);
    const fresh = projects.find((p) => p.id !== project.id)!;
    expect(await listRepos(db, { orgId: org.id, projectId: fresh.id })).toHaveLength(1);
    expect(await listRepos(db, { orgId: org.id, projectId: project.id })).toHaveLength(0);
  });

  test("an unbound project in another org with the same repo id is not used", async () => {
    const { db, org, f, project } = await granted();
    // The first org's project is unbound; the same repo id is then granted to another org's
    // installation. It must get a new project there and leave the first one alone.
    f.repos.set("100", []);
    await syncInstallation(db, f.facts, "100");
    const other = await createOrg(db, { slug: "other", name: "Other" });
    const g = fakeFacts();
    g.installations.set("200", inst("200"));
    g.repos.set("200", [repo("1", "api")]);
    const r = await syncInstallation(db, g.facts, "200", { claimedBy: other.id });
    expect(r.bound).toEqual(["acme/api"]);
    const theirs = await listProjects(db, { orgId: other.id });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).not.toBe(project.id);
    expect(await listRepos(db, { orgId: org.id, projectId: project.id })).toHaveLength(0);
  });

  test("a project that has a binding again is not taken twice", async () => {
    const { db, org, f, project } = await granted();
    f.repos.set("100", []);
    await syncInstallation(db, f.facts, "100");
    // The project got another repo meanwhile: it is no longer unbound.
    await bindRepo(
      db,
      { orgId: org.id, projectId: project.id },
      { forge: "github", owner: "acme", repo: "other" },
    );
    f.repos.set("100", [repo("1", "api")]);
    await syncInstallation(db, f.facts, "100");
    expect(await listProjects(db, { orgId: org.id })).toHaveLength(2);
  });

  test("the unbind and the re-attach are audited in the org chain", async () => {
    const { db, org, f, project } = await granted();
    f.repos.set("100", []);
    await syncInstallation(db, f.facts, "100");
    f.repos.set("100", [repo("1", "api")]);
    await syncInstallation(db, f.facts, "100");
    const rows = await listAudit(db, { orgId: org.id });
    const unbind = rows.filter((a) => a.op === "unbind_repo_binding");
    expect(unbind).toHaveLength(1);
    expect(JSON.parse(unbind[0]!.input)).toMatchObject({ forgeRepoId: "1", projectId: project.id });
    const re = rows.filter((a) => a.op === "reattach_repo_binding");
    expect(re).toHaveLength(1);
    expect(re[0]).toMatchObject({ effect: "write", outcome: "ok" });
    expect(JSON.parse(re[0]!.input)).toMatchObject({
      repo: "acme/api",
      installationId: "100",
      projectId: project.id,
    });
  });
});
