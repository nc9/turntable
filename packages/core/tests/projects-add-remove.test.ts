// add_project and remove_project (#577): an installation's repo access is a permission; a repo
// becomes a project only through an explicit add, and removing one keeps its history unless the
// owner deletes it. Runs on both dialects with TURNTABLE_TEST_DB.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  createRun,
  getProjectBySlug,
  listApiTokens,
  listAudit,
  listEvents,
  listProjects,
  listRepos,
  listRuns,
  openDatabase,
  type Db,
} from "../src/db";
import { putStoredSetting, upsertInstallation } from "../src/db/repos";
import { syncInstallation } from "../src/github/installations";
import { dispatch, registry, type Principal } from "../src/ops";
import type { DispatchEnv } from "../src/ops/dispatch";
import { mintToken } from "./ops-helpers";
import { fakeFacts, inst, repo, setup } from "./github-helpers";

let db: Db;
let orgId: string;
let f: ReturnType<typeof fakeFacts>;
let env: DispatchEnv;

beforeEach(async () => {
  const w = await setup("42", () => openDatabase(":memory:"));
  db = w.db;
  orgId = w.org.id;
  f = fakeFacts();
  f.installations.set("100", inst("100"));
  f.repos.set("100", [repo("1", "api"), repo("2", "web"), repo("3", "My.Repo")]);
  env = { registry, db, now: () => 1_800_000_000_000, githubFacts: f.facts };
  await syncInstallation(db, f.facts, "100");
});

const as = (role: "owner" | "admin" | "viewer", kind: "member" | "session" = "member") =>
  ({ kind: "principal", principal: { kind, id: `u-${role}`, orgId, role } as Principal }) as const;
const call = (cred: ReturnType<typeof as>, op: string, input: Record<string, unknown>) =>
  dispatch(env, cred, op, input);
const code = (r: Awaited<ReturnType<typeof call>>): string => (r.ok ? "ok" : r.error.code);
const scopeOf = async (slug: string) => ({
  orgId,
  projectId: (await getProjectBySlug(db, { orgId }, slug))!.id,
});

describe("add_project", () => {
  test("a sync with reachable repos made no project; add_project makes one with its binding", async () => {
    expect(await listProjects(db, { orgId })).toEqual([]);
    const r = await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    expect(r.ok && r.output).toEqual({
      project: "api",
      repo: "acme/api",
      created: true,
      reattached: false,
    });
    const projects = await listProjects(db, { orgId });
    expect(projects.map((p) => p.slug)).toEqual(["api"]);
    expect(projects[0]!.addedAt).not.toBeNull();
    expect(await listRepos(db, { orgId, projectId: projects[0]!.id })).toMatchObject([
      { owner: "acme", repo: "api", installationId: "100", forgeRepoId: "1" },
    ]);
    const audit = (await listAudit(db, { orgId })).filter((a) => a.op === "add_project");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.input)).toMatchObject({ project_slug: "api", repo: "acme/api" });
  });

  test("the project slug is optional, validated, and never an existing one", async () => {
    const named = await call(as("admin"), "add_project", {
      installation_id: "100",
      repo: "acme/web",
      project: "frontend",
    });
    expect(named.ok && (named.output as { project: string }).project).toBe("frontend");
    expect(
      code(
        await call(as("admin"), "add_project", {
          installation_id: "100",
          repo: "acme/api",
          project: "Not A Slug",
        }),
      ),
    ).toBe("invalid_input");
    // the slug is taken by another repo's project
    expect(
      code(
        await call(as("admin"), "add_project", {
          installation_id: "100",
          repo: "acme/api",
          project: "frontend",
        }),
      ),
    ).toBe("conflict");
    // the derived slug is lowercased
    const odd = await call(as("admin"), "add_project", {
      installation_id: "100",
      repo: "acme/my.repo",
    });
    expect(odd.ok && (odd.output as { project: string }).project).toBe("my-repo");
  });

  test("a repo the installation cannot reach, an unknown installation, and a viewer are refused", async () => {
    expect(
      code(await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/nope" })),
    ).toBe("invalid_input");
    expect(
      code(await call(as("admin"), "add_project", { installation_id: "999", repo: "acme/api" })),
    ).toBe("not_found");
    expect(
      code(await call(as("viewer"), "add_project", { installation_id: "100", repo: "acme/api" })),
    ).toBe("forbidden");
    expect(await listProjects(db, { orgId })).toEqual([]);
  });

  test("another org's installation looks like none", async () => {
    const other = await createOrg(db, { slug: "other", name: "Other" });
    await upsertInstallation(
      db,
      { orgId: other.id },
      {
        installationId: "200",
        appId: "42",
        accountLogin: "other",
        accountId: "8",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
      },
    );
    f.repos.set("200", [repo("9", "secret", "other")]);
    expect(
      code(
        await call(as("owner"), "add_project", { installation_id: "200", repo: "other/secret" }),
      ),
    ).toBe("not_found");
  });

  test("a repo already this org's project is returned unchanged; another org's is refused", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    const again = await call(as("admin"), "add_project", {
      installation_id: "100",
      repo: "acme/api",
    });
    expect(again.ok && (again.output as { created: boolean }).created).toBe(false);
    expect(await listProjects(db, { orgId })).toHaveLength(1);

    const other = await createOrg(db, { slug: "other", name: "Other" });
    const p = await createProject(db, { orgId: other.id }, { slug: "x", name: "x" });
    await bindRepo(
      db,
      { orgId: other.id, projectId: p.id },
      { forge: "github", owner: "acme", repo: "web", installationId: "555", forgeRepoId: "2" },
    );
    expect(
      code(await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/web" })),
    ).toBe("conflict");
  });

  test("a project-scoped token is refused; a session may add", async () => {
    const api = await createProject(db, { orgId }, { slug: "seed", name: "seed" });
    const tok = await mintToken(db, { orgId, projectId: api.id }, "release_operator");
    const r = await dispatch(env, { kind: "bearer", token: tok.secret }, "add_project", {
      installation_id: "100",
      repo: "acme/api",
    });
    expect(r.ok).toBe(false);
    expect(
      code(
        await call(as("admin", "session"), "add_project", {
          installation_id: "100",
          repo: "acme/api",
        }),
      ),
    ).toBe("ok");
  });

  test("an added project is listed as active even with no runs and no ingest", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    const list = await call(as("admin"), "list_projects", {});
    expect(
      list.ok && (list.output as { projects: { slug: string; setup: string }[] }).projects,
    ).toMatchObject([{ slug: "api", setup: "active" }]);
  });
});

describe("access lost and regained", () => {
  test("an installation losing access unbinds the added project and keeps its history; it reads as no access", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    const scope = await scopeOf("api");
    await createRun(db, scope, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
    });
    f.repos.set("100", [repo("2", "web")]);
    const r = await syncInstallation(db, f.facts, "100");
    expect(r.unbound).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toEqual([]);
    expect(await listRuns(db, scope)).toHaveLength(1);
    const list = await call(as("admin"), "list_projects", {});
    expect(
      list.ok && (list.output as { projects: { slug: string; no_access: boolean }[] }).projects,
    ).toMatchObject([{ slug: "api", no_access: true }]);
    // access comes back: the same project, with its run
    f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    expect((await syncInstallation(db, f.facts, "100")).bound).toEqual(["acme/api"]);
    expect(await listRepos(db, scope)).toHaveLength(1);
    expect(await listRuns(db, scope)).toHaveLength(1);
    expect(await listProjects(db, { orgId })).toHaveLength(1);
  });
});

describe("remove_project", () => {
  test("unbinds and keeps the project, its runs and settings; a sync does not bind it back; add_project does", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    const scope = await scopeOf("api");
    await createRun(db, scope, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
    });
    const r = await call(as("admin"), "remove_project", { project: "api" });
    expect(r.ok && r.output).toEqual({ project: "api", unbound: ["acme/api"], deleted: false });
    expect(await listRepos(db, scope)).toEqual([]);
    expect(await listRuns(db, scope)).toHaveLength(1);
    // the repo is still reachable; sync records it and binds nothing
    const s = await syncInstallation(db, f.facts, "100");
    expect(s.bound).toEqual([]);
    expect(await listRepos(db, scope)).toEqual([]);
    // an explicit add brings the same project back
    const back = await call(as("admin"), "add_project", {
      installation_id: "100",
      repo: "acme/api",
    });
    expect(back.ok && back.output).toMatchObject({
      project: "api",
      created: false,
      reattached: true,
    });
    expect(await listRepos(db, scope)).toHaveLength(1);
    expect(await listProjects(db, { orgId })).toHaveLength(1);
    expect(await listRuns(db, scope)).toHaveLength(1);
  });

  test("delete_history: a token, an admin and an owner session without a step-up are refused; nothing is deleted", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    const tok = await mintToken(db, { orgId }, "release_operator");
    const viaToken = await dispatch(env, { kind: "bearer", token: tok.secret }, "remove_project", {
      project: "api",
      delete_history: true,
    });
    expect(viaToken.ok).toBe(false);
    expect(
      code(await call(as("admin"), "remove_project", { project: "api", delete_history: true })),
    ).toBe("forbidden");
    const noStepUp = await call(as("owner", "session"), "remove_project", {
      project: "api",
      delete_history: true,
    });
    expect(code(noStepUp)).toBe("forbidden");
    expect(await getProjectBySlug(db, { orgId }, "api")).toBeDefined();
  });

  test("delete_history by the owner deletes the project and all its rows, only that project's, and audits it", async () => {
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/api" });
    await call(as("admin"), "add_project", { installation_id: "100", repo: "acme/web" });
    const gone = await scopeOf("api");
    const kept = await scopeOf("web");
    for (const sc of [gone, kept]) {
      await createRun(db, sc, {
        workflowPath: ".github/workflows/ci.yml",
        event: "push",
        ref: "refs/heads/main",
      });
      await mintToken(db, sc, "reader");
      await putStoredSetting(
        db,
        { kind: "project", id: sc.projectId, orgId },
        "checks_mode",
        "shadow",
        "t",
        1,
      );
    }
    const r = await call(as("owner"), "remove_project", { project: "api", delete_history: true });
    expect(r.ok && r.output).toEqual({ project: "api", unbound: ["acme/api"], deleted: true });
    expect(await getProjectBySlug(db, { orgId }, "api")).toBeUndefined();
    expect(await listRuns(db, gone)).toEqual([]);
    expect(await listEvents(db, gone, { after: 0, limit: 100 })).toEqual([]);
    expect(await listApiTokens(db, gone)).toEqual([]);
    expect(await listRepos(db, gone)).toEqual([]);
    // the other project is whole
    expect(await listRuns(db, kept)).toHaveLength(1);
    expect((await listApiTokens(db, kept)).length).toBe(1);
    expect(await listRepos(db, kept)).toHaveLength(1);
    const audit = (await listAudit(db, { orgId })).filter((a) => a.op === "remove_project");
    expect(
      audit.some(
        (a) => JSON.parse(a.input).delete_history === true && JSON.parse(a.input).project === "api",
      ),
    ).toBe(true);
  });
});
