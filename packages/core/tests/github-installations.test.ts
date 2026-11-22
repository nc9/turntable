import { describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  getInstallation,
  listProjects,
  listRepos,
} from "../src/db";
import { syncInstallation } from "../src/github/installations";
import { fakeFacts, inst, repo, setup } from "./github-helpers";

describe("syncInstallation", () => {
  test("maps the installation to the App's org and its repos to projects, from API facts", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ outcome: "synced", bound: ["acme/api", "acme/web"], conflicts: [] });
    expect(await getInstallation(db, "100")).toMatchObject({
      orgId: org.id,
      accountLogin: "acme",
      status: "active",
      appId: "42",
    });
    const projects = await listProjects(db, { orgId: org.id });
    expect(projects.map((p) => p.slug).sort()).toEqual(["api", "web"]);
    const bound = await listRepos(db, {
      orgId: org.id,
      projectId: projects.find((p) => p.slug === "api")!.id,
    });
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      owner: "acme",
      repo: "api",
      installationId: "100",
      forgeRepoId: "1",
    });
  });

  test("idempotent: a replay changes nothing", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    await syncInstallation(db, f.facts, "100");
    const again = await syncInstallation(db, f.facts, "100");
    expect(again.bound).toEqual([]);
    expect(await listProjects(db, { orgId: org.id })).toHaveLength(1);
  });

  test("an installation of another App is refused and binds nothing", async () => {
    const { db, org } = await setup("42");
    const f = fakeFacts();
    f.installations.set("200", inst("200", "999"));
    f.repos.set("200", [repo("9", "evil")]);
    await expect(syncInstallation(db, f.facts, "200")).rejects.toThrow(/belongs to app 999/);
    expect(await getInstallation(db, "200")).toBeUndefined();
    expect(await listProjects(db, { orgId: org.id })).toHaveLength(0);
    expect(f.calls.listRepos).toBe(0);
  });

  test("the payload's claims do not matter: only the installation id is used, repos come from the API", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    // The webhook (not given to this function) might claim acme/victim; the API says otherwise.
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "real")]);
    await syncInstallation(db, f.facts, "100");
    const slugs = (await listProjects(db, { orgId: org.id })).map((p) => p.slug);
    expect(slugs).toEqual(["real"]);
  });

  test("a repo already bound in another org is left alone and reported", async () => {
    const { db, org } = await setup();
    const other = await createOrg(db, { slug: "other", name: "Other" });
    const p = await createProject(db, { orgId: other.id }, { slug: "api", name: "api" });
    await bindRepo(
      db,
      { orgId: other.id, projectId: p.id },
      {
        forge: "github",
        owner: "acme",
        repo: "api",
        installationId: "555",
        forgeRepoId: "1",
      },
    );
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r.conflicts).toEqual(["acme/api"]);
    expect(r.bound).toEqual(["acme/web"]);
    expect(await listRepos(db, { orgId: other.id, projectId: p.id })).toHaveLength(1);
    expect((await listProjects(db, { orgId: org.id })).map((x) => x.slug)).toEqual(["web"]);
  });

  test("a repo removed from the installation is unbound; a suspended installation binds nothing new", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    await syncInstallation(db, f.facts, "100");
    f.repos.set("100", [repo("1", "api")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r.unbound).toEqual(["acme/web"]);

    f.installations.set("100", inst("100", "42", { suspended: true }));
    f.repos.set("100", [repo("1", "api"), repo("3", "new")]);
    const s = await syncInstallation(db, f.facts, "100");
    expect(s.outcome).toBe("suspended");
    expect(s.bound).toEqual([]);
    expect((await getInstallation(db, "100"))?.status).toBe("suspended");
    expect(await listProjects(db, { orgId: org.id })).toHaveLength(2);
  });

  test("an installation GitHub no longer knows is marked deleted and its repos unbound, whatever a payload says", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    await syncInstallation(db, f.facts, "100");
    f.installations.delete("100");
    const r = await syncInstallation(db, f.facts, "100");
    expect(r).toMatchObject({ outcome: "deleted", unbound: ["acme/api"] });
    expect((await getInstallation(db, "100"))?.status).toBe("deleted");
    const unknown = await syncInstallation(db, f.facts, "999");
    expect(unknown.outcome).toBe("unknown");
    void org;
  });
});
