// Onboarding lane A3: `list_installation_repos`, `onboard_repos`, `preview_workflows` and
// `run_default_branch`. GitHub is fake: the App's repo list is a stub, the preview reads files from
// a stub reader, and the run goes through a real Poller over the fake GitHub of github-stub.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  createRun,
  getProjectChecksMode,
  listAudit,
  listRuns,
  openDatabase,
  setProjectChecksMode,
  type Db,
} from "../src/db";
import {
  createOnboarding,
  getOnboarding,
  getProjectBySlug,
  listRepos,
  getProjectIngest,
  getProjectSandboxSettings,
  setProjectIngest,
  setProjectSandboxSettings,
  upsertInstallation,
} from "../src/db/repos";
import * as s from "../src/db/schema";
import { dispatch, registry, type Principal } from "../src/ops";
import { type DispatchEnv, SESSION_WRITE_OPS } from "../src/ops/dispatch";
import { runDefaultBranchInput } from "../src/ops/onboarding-schemas";
import { PREVIEW_MAX_BYTES, PREVIEW_MAX_FILES } from "../src/ops/onboarding-schemas";
import type { GithubFacts, GithubRepoFacts } from "../src/github/api";
import { Poller, pollConfigSchema } from "../src/poll";
import type { RepoReader } from "../src/poll/onboarding-forge";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { loadTomlSettings } from "../src/settings/toml";
import { mintToken } from "./ops-helpers";
import { makeGithub, SHA } from "./github-stub";

const INSTALL = "9001";
const CI = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

let db: Db;
let orgId: string;
let projects: Record<"web" | "api", { projectId: string }>;
let userId: string;
const NOW = 1_800_000_000_000;

const repo = (id: string, name: string, over: Partial<GithubRepoFacts> = {}): GithubRepoFacts => ({
  id,
  name,
  owner: "acme",
  fullName: `acme/${name}`,
  private: true,
  defaultBranch: "main",
  ...over,
});
let granted: GithubRepoFacts[];

const facts: GithubFacts = {
  getInstallation: async () => undefined,
  listInstallationRepos: async () => granted,
};

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  orgId = org.id;
  await upsertInstallation(
    db,
    { orgId },
    {
      installationId: INSTALL,
      appId: "42",
      accountLogin: "acme",
      accountId: "7",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active",
    },
  );
  projects = {} as typeof projects;
  for (const [slug, id] of [
    ["web", "1001"],
    ["api", "1002"],
  ] as const) {
    const p = await createProject(db, { orgId }, { slug, name: slug });
    await bindRepo(
      db,
      { orgId, projectId: p.id },
      { forge: "github", owner: "acme", repo: slug, installationId: INSTALL, forgeRepoId: id },
    );
    projects[slug] = { projectId: p.id };
  }
  granted = [repo("1001", "web"), repo("1002", "api"), repo("1003", "new-one", { private: false })];
  // A signed-in user with a GitHub login, for the session principal.
  userId = "user-1";
  await db.run(async (h) => {
    await h.orm.insert(s.users).values({ id: userId, displayName: "Octo" });
    await h.orm
      .insert(s.githubIdentities)
      .values({ githubUserId: "555", userId, login: "octocat" });
  });
});

const session = (role: "owner" | "admin" | "member" | "viewer" = "admin"): Principal => ({
  kind: "session",
  id: userId,
  orgId,
  role,
});
const env = (over: Partial<DispatchEnv> = {}): DispatchEnv => ({
  registry,
  db,
  now: () => NOW,
  githubFacts: facts,
  ...over,
});
const asPrincipal = (p: Principal) => ({ kind: "principal", principal: p }) as const;
const scopeOf = (slug: "web" | "api") => ({ orgId, projectId: projects[slug].projectId });

type Res = Awaited<ReturnType<typeof dispatch>>;
const out = <T>(r: Res): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.output as T;
};
const code = (r: Res): string => (r.ok ? "ok" : r.error.code);

describe("op wiring", () => {
  test("the writes are open to owner and admin sessions, and the preview is untrusted output", () => {
    expect(SESSION_WRITE_OPS.has("onboard_repos")).toBe(true);
    expect(SESSION_WRITE_OPS.has("run_default_branch")).toBe(true);
    expect(registry.get("preview_workflows")?.untrustedOutput).toBe(true);
    expect(registry.get("onboard_repos")?.auth.minRole).toBe("admin");
    expect(registry.get("run_default_branch")?.auth.minRole).toBe("admin");
    expect(registry.get("list_installation_repos")?.auth.minRole).toBe("reader");
  });

  test("run_default_branch takes an optional onboarding_id", () => {
    expect(runDefaultBranchInput.safeParse({ project: "web" }).success).toBe(true);
    expect(runDefaultBranchInput.safeParse({ project: "web", onboarding_id: "ob1" }).success).toBe(
      true,
    );
    expect(runDefaultBranchInput.safeParse({ project: "web", onboarding_id: "" }).success).toBe(
      false,
    );
  });
});

describe("list_installation_repos", () => {
  test("lists granted repos with project, status, mode and paused", async () => {
    await setProjectSandboxSettings(db, scopeOf("api"), { maxConcurrent: 0 });
    const reader = (await mintToken(db, { orgId }, "reader", { kind: "agent" })).secret;
    const res = out<{ repos: Record<string, unknown>[]; next_cursor: string | null }>(
      await dispatch(env(), { kind: "bearer", token: reader }, "list_installation_repos", {
        installation_id: INSTALL,
      }),
    );
    expect(res.next_cursor).toBeNull();
    expect(res.repos).toEqual([
      {
        repo: "acme/api",
        repo_id: "1002",
        private: true,
        project: "api",
        status: "in_org",
        mode: "off",
        paused: true,
      },
      {
        repo: "acme/new-one",
        repo_id: "1003",
        private: false,
        project: null,
        status: "new",
        mode: null,
        paused: false,
      },
      {
        repo: "acme/web",
        repo_id: "1001",
        private: true,
        project: "web",
        status: "in_org",
        mode: "off",
        paused: false,
      },
    ]);
  });

  test("pages by name with limit and cursor", async () => {
    const reader = (await mintToken(db, { orgId }, "reader", { kind: "agent" })).secret;
    const page = async (extra: Record<string, unknown>) =>
      out<{ repos: { repo: string }[]; next_cursor: string | null }>(
        await dispatch(env(), { kind: "bearer", token: reader }, "list_installation_repos", {
          installation_id: INSTALL,
          ...extra,
        }),
      );
    const first = await page({ limit: 2 });
    expect(first.repos.map((r) => r.repo)).toEqual(["acme/api", "acme/new-one"]);
    expect(first.next_cursor).toBe("acme/new-one");
    const second = await page({ limit: 2, cursor: first.next_cursor });
    expect(second.repos.map((r) => r.repo)).toEqual(["acme/web"]);
    expect(second.next_cursor).toBeNull();
  });

  test("another org's installation looks like none", async () => {
    const other = await createOrg(db, { slug: "other", name: "Other" });
    const tok = (await mintToken(db, { orgId: other.id }, "reader")).secret;
    const r = await dispatch(env(), { kind: "bearer", token: tok }, "list_installation_repos", {
      installation_id: INSTALL,
    });
    expect(code(r)).toBe("not_found");
  });
});

describe("list_projects setup state", () => {
  const list = async (include?: boolean, e = env()) =>
    out<{ projects: { slug: string; setup: string }[] }>(
      await dispatch(
        e,
        asPrincipal(session()),
        "list_projects",
        include === undefined ? {} : { include_available: include },
      ),
    );
  const slugs = (r: { projects: { slug: string }[] }) => r.projects.map((p) => p.slug).toSorted();

  test("sync-created projects with no ingest are hidden unless asked for", async () => {
    expect(slugs(await list())).toEqual([]);
    const all = await list(true);
    expect(slugs(all)).toEqual(["api", "web"]);
    expect(all.projects.every((p) => p.setup === "available")).toBe(true);
  });

  test("onboard_repos makes a project active", async () => {
    out(
      await dispatch(env(), asPrincipal(session()), "onboard_repos", {
        installation_id: INSTALL,
        repos: [
          { repo_id: "1001", enable: true },
          { repo_id: "1002", enable: false },
        ],
      }),
    );
    const r = await list();
    expect(r.projects).toMatchObject([{ slug: "web", setup: "active" }]);
    expect(slugs(await list(true))).toEqual(["api", "web"]);
  });

  test("a static poll entry names a project", async () => {
    const r = await list(false, env({ staticPollProjects: ["acme/api", "other/web"] }));
    expect(slugs(r)).toEqual(["api"]);
  });

  test("a project with a run is active", async () => {
    await createRun(db, scopeOf("web"), {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
    });
    expect(slugs(await list())).toEqual(["web"]);
  });

  test("paging over a mix keeps the cursor honest", async () => {
    await setProjectIngest(db, scopeOf("api"), "{}");
    const first = out<{ projects: { slug: string }[]; next_cursor: string | null }>(
      await dispatch(env(), asPrincipal(session()), "list_projects", { limit: 1 }),
    );
    expect(first.projects).toHaveLength(1);
    expect(first.next_cursor).toBeNull();
  });
});

describe("onboard_repos", () => {
  const call = (p: Principal, repos: unknown, over: Record<string, unknown> = {}, e = env()) =>
    dispatch(e, asPrincipal(p), "onboard_repos", {
      installation_id: INSTALL,
      repos,
      ...over,
    });

  test("ticked repos get the defaults through the setters; unticked ones are paused", async () => {
    const r = out<{ projects: Record<string, unknown>[] }>(
      await call(session(), [
        { repo_id: "1001", enable: true },
        { repo_id: "1002", enable: false },
      ]),
    );
    expect(r.projects).toEqual([
      { slug: "web", repo: "acme/web", enabled: true, mode: "off", paused: false },
      { slug: "api", repo: "acme/api", enabled: false, mode: "off", paused: true },
    ]);
    const web = scopeOf("web");
    expect((await getProjectSandboxSettings(db, web)).maxConcurrent).toBe(2);
    expect(await getProjectChecksMode(db, web)).toBe("off");
    expect(JSON.parse((await getProjectIngest(db, web))!)).toMatchObject({
      defaultBranch: "main",
      prMode: "allowlist",
      authors: ["octocat"],
      vars: { TURNTABLE_CI: "true" },
      tagRefs: [],
      mergeQueue: false,
    });
    const api = scopeOf("api");
    expect((await getProjectSandboxSettings(db, api)).maxConcurrent).toBe(0);
    expect(await getProjectIngest(db, api)).toBeNull();
    expect(await getProjectChecksMode(db, api)).toBe("off");
    // Audited: the dispatcher's row and the setting change.
    const ops = (await listAudit(db, { orgId })).map((a) => a.op);
    expect(ops).toContain("onboard_repos");
  });

  test("no bearer token can call it: tokens never hold the admin role", async () => {
    for (const kind of ["person", "agent"] as const) {
      const tok = await mintToken(db, { orgId }, "release_operator", { kind });
      const r = await dispatch(env(), { kind: "bearer", token: tok.secret }, "onboard_repos", {
        installation_id: INSTALL,
        repos: [{ repo_id: "1001", enable: true }],
      });
      expect(code(r)).toBe("forbidden");
    }
    expect(await getProjectIngest(db, scopeOf("web"))).toBeNull();
  });

  const input = { installation_id: INSTALL, repos: [{ repo_id: "1001", enable: true }] };
  const tokenCtx = (tokenKind: "agent" | "person", extra: Record<string, unknown> = {}) => ({
    db,
    scope: { orgId },
    now: () => NOW,
    githubFacts: facts,
    principal: {
      kind: "token" as const,
      id: "t1",
      orgId,
      projectId: null,
      // No token holds admin on the wire; this hand-built principal stands in for one that did.
      role: "admin" as never,
      tokenKind,
    },
    ...extra,
  });

  test("defence in depth: the handler itself refuses an agent token", async () => {
    await expect(
      registry.get("onboard_repos")!.handler(tokenCtx("agent"), input),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await getProjectIngest(db, scopeOf("web"))).toBeNull();
  });

  test("a person token (were it ever admin) has no GitHub login: the allowlist stays empty", async () => {
    await registry.get("onboard_repos")!.handler(tokenCtx("person"), input);
    expect(JSON.parse((await getProjectIngest(db, scopeOf("web")))!).authors).toEqual([]);
  });

  test("a member, a viewer and a project-narrowed call are refused", async () => {
    for (const role of ["member", "viewer"] as const) {
      expect(code(await call(session(role), [{ repo_id: "1001", enable: true }]))).toBe(
        "forbidden",
      );
    }
    // An admin session narrowed to one project (the `project` input) is refused too.
    const r2 = await dispatch(env(), asPrincipal(session()), "onboard_repos", {
      ...input,
      project: "web",
    });
    expect(code(r2)).toBe("forbidden");
    expect(await getProjectChecksMode(db, scopeOf("web"))).toBe("off");
  });

  test("a registry lock wins and the whole batch rolls back", async () => {
    const toml = loadTomlSettings("t.toml", settingsRegistry, () =>
      ["[orgs.acme.projects.web]", 'checks_mode = "off"'].join("\n"),
    );
    const e = env({ settings: createSettingsRuntime(settingsRegistry, {}, toml) });
    const r = await call(
      session(),
      [
        { repo_id: "1002", enable: true },
        { repo_id: "1001", enable: true },
      ],
      {},
      e,
    );
    expect(code(r)).toBe("conflict");
    expect(r.ok ? "" : r.error.message).toContain("locked");
    // Nothing of the first repo stayed.
    expect((await getProjectSandboxSettings(db, scopeOf("api"))).maxConcurrent).toBeNull();
    expect(await getProjectIngest(db, scopeOf("api"))).toBeNull();
  });

  test("a repo the installation does not grant is refused whole; pausing a repo that is not a project is refused", async () => {
    expect(
      code(
        await call(session(), [
          { repo_id: "1001", enable: true },
          { repo_id: "9", enable: true },
        ]),
      ),
    ).toBe("invalid_input");
    expect(code(await call(session(), [{ repo_id: "1003", enable: false }]))).toBe("invalid_input");
    expect(await getProjectIngest(db, scopeOf("web"))).toBeNull();
  });

  test("enabling a granted repo that is not a project adds it first, exactly as add_project does", async () => {
    const r = await call(session(), [{ repo_id: "1003", enable: true }]);
    expect(r.ok).toBe(true);
    const p = await getProjectBySlug(db, { orgId }, "new-one");
    expect(p).toBeDefined();
    expect(p!.addedAt).not.toBeNull();
    expect(await listRepos(db, { orgId, projectId: p!.id })).toMatchObject([
      { owner: "acme", repo: "new-one", installationId: INSTALL, forgeRepoId: "1003" },
    ]);
    expect(
      (await listAudit(db, { orgId })).some(
        (a) => a.op === "add_project" && JSON.parse(a.input).via === "onboard_repos",
      ),
    ).toBe(true);
  });

  test("more than 100 repos, or a repo twice, is refused", async () => {
    const many = Array.from({ length: 101 }, (_, n) => ({ repo_id: String(n + 1), enable: false }));
    expect(code(await call(session(), many))).toBe("invalid_input");
    expect(
      code(
        await call(session(), [
          { repo_id: "1001", enable: true },
          { repo_id: "1001", enable: false },
        ]),
      ),
    ).toBe("invalid_input");
  });

  test("existing ingest settings and an operator's cap are kept", async () => {
    const web = scopeOf("web");
    await setProjectIngest(
      db,
      web,
      JSON.stringify({ defaultBranch: "trunk", prMode: "approval", authors: ["maint"] }),
    );
    await setProjectSandboxSettings(db, web, { maxConcurrent: 1 });
    expect(code(await call(session(), [{ repo_id: "1001", enable: true }]))).toBe("ok");
    expect(JSON.parse((await getProjectIngest(db, web))!)).toMatchObject({
      defaultBranch: "trunk",
      prMode: "approval",
      authors: ["maint"],
    });
    expect(JSON.parse((await getProjectIngest(db, web))!).vars?.TURNTABLE_CI).toBeUndefined();
    expect((await getProjectSandboxSettings(db, web)).maxConcurrent).toBe(1);
  });

  const snapshot = async (slug: "web" | "api") => {
    const sc = scopeOf(slug);
    return {
      mode: await getProjectChecksMode(db, sc),
      sandbox: await getProjectSandboxSettings(db, sc),
      ingest: await getProjectIngest(db, sc),
    };
  };

  for (const existing of ["shadow", "live"] as const) {
    test(`an existing ${existing} project onboarded with no mode keeps every setting`, async () => {
      const web = scopeOf("web");
      await setProjectChecksMode(db, web, existing);
      const before = await snapshot("web");
      expect(code(await call(session(), [{ repo_id: "1001", enable: true }]))).toBe("ok");
      expect(await snapshot("web")).toEqual(before);
      expect(before.mode).toBe(existing);
      expect(before.ingest).toBeNull();
      expect(before.sandbox.maxConcurrent).toBeNull();
    });

    test(`an explicit mode on an existing ${existing} project changes only the mode`, async () => {
      const web = scopeOf("web");
      await setProjectChecksMode(db, web, existing);
      const before = await snapshot("web");
      const to = existing === "shadow" ? "live" : "off";
      expect(code(await call(session(), [{ repo_id: "1001", enable: true, mode: to }]))).toBe("ok");
      expect(await snapshot("web")).toEqual({ ...before, mode: to });
    });
  }

  test("an existing project with its own cap and ingest keeps both, and no var is added", async () => {
    const web = scopeOf("web");
    await setProjectChecksMode(db, web, "shadow");
    await setProjectIngest(db, web, JSON.stringify({ defaultBranch: "trunk", prMode: "approval" }));
    await setProjectSandboxSettings(db, web, { maxConcurrent: 1 });
    const before = await snapshot("web");
    expect(code(await call(session(), [{ repo_id: "1001", enable: true }]))).toBe("ok");
    expect(await snapshot("web")).toEqual(before);
  });

  test("a new project with no mode gets off and the defaults", async () => {
    expect(code(await call(session(), [{ repo_id: "1001", enable: true }]))).toBe("ok");
    const after = await snapshot("web");
    expect(after.mode).toBe("off");
    expect(after.sandbox.maxConcurrent).toBe(2);
    expect(JSON.parse(after.ingest!)).toMatchObject({
      prMode: "allowlist",
      authors: ["octocat"],
      vars: { TURNTABLE_CI: "true" },
    });
  });

  test("the instance per-org cap clamps the default", async () => {
    expect(
      code(
        await call(session(), [{ repo_id: "1001", enable: true }], {}, env({ instanceOrgCap: 1 })),
      ),
    ).toBe("ok");
    expect((await getProjectSandboxSettings(db, scopeOf("web"))).maxConcurrent).toBe(1);
  });
});

// ---- preview ----

const SENTINEL = "SECRET_SENTINEL_do_not_return";
function reader(files: Record<string, string>, sizes: Record<string, number> = {}): RepoReader {
  return {
    defaultBranch: async () => "main",
    head: async () => SHA("a"),
    listWorkflows: async () =>
      Object.entries(files).map(([path, text]) => ({ path, size: sizes[path] ?? text.length })),
    fileAt: async (path) => files[path],
  };
}
const preview = async (r: RepoReader, p: Principal = session("viewer")) => {
  type P = {
    sha: string;
    truncated: boolean;
    workflows: {
      path: string;
      name: string | null;
      triggers: string[];
      ingested: boolean;
      too_large: boolean;
      jobs: {
        job_id: string;
        name: string | null;
        verdict: string;
        reason?: string;
        fix?: string;
      }[];
    }[];
  };
  const res = await dispatch(
    env({ repoReader: async () => r }),
    asPrincipal(p),
    "preview_workflows",
    { project: "web" },
  );
  return { res, body: res.ok ? (res.output as P) : undefined };
};

describe("preview_workflows", () => {
  test("run, skip and fail rows with the fix text, and no file contents", async () => {
    const wf = `name: CI
on: [push, schedule]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ${SENTINEL}
  mac:
    runs-on: macos-14
    steps:
      - run: echo hi
  gated:
    if: vars.TURNTABLE_CI != 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo skipped
  svc:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres
    steps:
      - run: echo svc
  call:
    uses: ./.github/workflows/other.yml
`;
    const { res, body } = await preview(reader({ ".github/workflows/ci.yml": wf }));
    expect(res.ok).toBe(true);
    const w = body!.workflows[0]!;
    expect(w).toMatchObject({
      path: ".github/workflows/ci.yml",
      name: "CI",
      triggers: ["push", "schedule"],
      ingested: true,
      too_large: false,
    });
    const by = Object.fromEntries(w.jobs.map((j) => [j.job_id, j]));
    expect(by.build).toMatchObject({ verdict: "run" });
    expect(by.gated).toMatchObject({ verdict: "skip" });
    expect(by.mac?.verdict).toBe("fail");
    expect(by.mac?.reason).toContain("macOS");
    expect(by.mac?.fix).toBe(
      "add `if: vars.TURNTABLE_CI != 'true'` to the job to skip it on Turntable",
    );
    expect(by.svc?.verdict).toBe("fail");
    expect(by.svc?.fix).toContain("Docker-capable size class");
    expect(by.call?.verdict).toBe("fail");
    expect(by.call?.reason).toContain("reusable workflow");
    expect(by.call?.fix).toContain("inline the called workflow");
    expect(body!.sha).toBe(SHA("a"));
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
  });

  test("a schedule-only workflow is not ingested", async () => {
    const { body } = await preview(
      reader({
        ".github/workflows/nightly.yml":
          "on: schedule\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
      }),
    );
    expect(body!.workflows[0]).toMatchObject({ ingested: false, triggers: ["schedule"] });
  });

  test("a file over the byte budget is a too_large row with no jobs", async () => {
    const small = ".github/workflows/a.yml";
    const big = ".github/workflows/b.yml";
    const { body } = await preview(
      reader({ [small]: CI, [big]: CI }, { [small]: 100, [big]: PREVIEW_MAX_BYTES }),
    );
    const [a, b] = body!.workflows;
    expect(a).toMatchObject({ path: small, too_large: false });
    expect(a!.jobs.length).toBe(1);
    expect(b).toMatchObject({ path: big, too_large: true, jobs: [], name: null, ingested: false });
    expect(body!.truncated).toBe(false);
  });

  test("more than 50 files are cut and flagged truncated", async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < PREVIEW_MAX_FILES + 10; n++)
      files[`.github/workflows/w${String(n).padStart(3, "0")}.yml`] = CI;
    const { body } = await preview(reader(files));
    expect(body!.workflows).toHaveLength(PREVIEW_MAX_FILES);
    expect(body!.truncated).toBe(true);
  });

  test("markdown and HTML in a job name come back as plain data", async () => {
    const name = "[x](http://evil) <img src=x onerror=alert(1)> **bold**";
    const wf = `on: push\njobs:\n  build:\n    name: ${JSON.stringify(name)}\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    const { body } = await preview(reader({ ".github/workflows/ci.yml": wf }));
    expect(body!.workflows[0]!.jobs[0]!.name).toBe(name);
    expect(registry.get("preview_workflows")?.untrustedOutput).toBe(true);
  });

  test("files that are not .yml or .yaml under .github/workflows are ignored", async () => {
    const { body } = await preview(
      reader({ ".github/workflows/readme.md": "# hi", ".github/workflows/ci.yaml": CI }),
    );
    expect(body!.workflows.map((w) => w.path)).toEqual([".github/workflows/ci.yaml"]);
  });
});

// ---- run_default_branch ----

describe("run_default_branch", () => {
  let gh: ReturnType<typeof makeGithub>;
  let poller: Poller;

  beforeEach(() => {
    gh = makeGithub("acme/web");
    gh.state.files.set("*", CI);
    poller = new Poller({
      db,
      config: pollConfigSchema.parse({
        allowUnauthenticated: true,
        repos: [
          { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
        ],
      }),
      fetch: gh.fetch,
      now: () => NOW,
      bindings: true,
    });
  });

  const run = (p: Principal, input: Record<string, unknown> = {}) =>
    dispatch(
      env({ defaultBranchRunner: (sc, r) => poller.runDefaultBranch(sc, r) }),
      asPrincipal(p),
      "run_default_branch",
      { project: "web", ...input },
    );
  const onboard = () =>
    dispatch(env(), asPrincipal(session()), "onboard_repos", {
      installation_id: INSTALL,
      repos: [{ repo_id: "1001", enable: true }],
    });

  test("creates a protected push run at the head, then returns it again", async () => {
    expect(code(await onboard())).toBe("ok");
    const first = out<{ run_id: string; sha: string; trust_class: string; created: boolean }>(
      await run(session()),
    );
    expect(first).toMatchObject({ sha: SHA("a"), trust_class: "protected", created: true });
    const runs = await listRuns(db, scopeOf("web"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ event: "push", ref: "refs/heads/main", sha: SHA("a") });
    const again = out<{ run_id: string; created: boolean }>(await run(session()));
    expect(again).toMatchObject({ run_id: first.run_id, created: false });
    expect(await listRuns(db, scopeOf("web"))).toHaveLength(1);
    // A new head is a new run.
    gh.state.head = { ...gh.state.head, sha: SHA("b") };
    const next = out<{ run_id: string; sha: string; created: boolean }>(await run(session()));
    expect(next).toMatchObject({ sha: SHA("b"), created: true });
    expect(next.run_id).not.toBe(first.run_id);
  });

  test("a run the poller already made is the existing one", async () => {
    await onboard();
    await poller.pollAll();
    const [made] = await listRuns(db, scopeOf("web"));
    const r = out<{ run_id: string; created: boolean }>(await run(session()));
    expect(r).toMatchObject({ run_id: made!.id, created: false });
  });

  test("a paused project is refused", async () => {
    await onboard();
    await setProjectSandboxSettings(db, scopeOf("web"), { maxConcurrent: 0 });
    const r = await run(session());
    expect(code(r)).toBe("conflict");
    expect(r.ok ? "" : r.error.message).toBe("this project is paused; enable it first");
    expect(await listRuns(db, scopeOf("web"))).toHaveLength(0);
  });

  test("a member is refused, and no bearer token can call it", async () => {
    await onboard();
    expect(code(await run(session("member")))).toBe("forbidden");
    for (const kind of ["agent", "person"] as const) {
      const t = await mintToken(db, scopeOf("web"), "release_operator", { kind });
      const r = await dispatch(
        env({ defaultBranchRunner: (sc, x) => poller.runDefaultBranch(sc, x) }),
        { kind: "bearer", token: t.secret },
        "run_default_branch",
        { project: "web" },
      );
      expect(code(r)).toBe("forbidden");
    }
    expect(await listRuns(db, scopeOf("web"))).toHaveLength(0);
  });

  test("defence in depth: the handler refuses an agent token and lets a person token through", async () => {
    await onboard();
    const ctx = (tokenKind: "agent" | "person") => ({
      db,
      scope: scopeOf("web"),
      now: () => NOW,
      defaultBranchRunner: (sc: { orgId: string; projectId: string }, x: string | undefined) =>
        poller.runDefaultBranch(sc, x),
      principal: {
        kind: "token" as const,
        id: "t1",
        orgId,
        projectId: null,
        role: "release_operator" as const,
        tokenKind,
      },
    });
    const op = registry.get("run_default_branch")!;
    await expect(op.handler(ctx("agent"), {})).rejects.toMatchObject({ code: "forbidden" });
    expect(await listRuns(db, scopeOf("web"))).toHaveLength(0);
    await expect(op.handler(ctx("person"), {})).resolves.toMatchObject({ created: true });
  });

  test("the run is audited with its sha and class", async () => {
    await onboard();
    expect(code(await run(session()))).toBe("ok");
    const audit = (await listAudit(db, { orgId })).find((a) => a.op === "run_default_branch");
    expect(audit?.outcome).toBe("ok");
    expect(JSON.stringify(audit?.input)).toContain("protected");
  });

  test("onboarding_id records first_run_id on that row, and only that org's row", async () => {
    await onboard();
    const ob = await createOnboarding(db, { orgId }, { installationId: INSTALL });
    const r = out<{ run_id: string }>(await run(session(), { onboarding_id: ob.id }));
    expect((await getOnboarding(db, { orgId }, ob.id))?.firstRunId).toBe(r.run_id);
    // Unknown, or another org's onboarding: refused before anything runs.
    const other = await createOrg(db, { slug: "other", name: "Other" });
    const theirs = await createOnboarding(db, { orgId: other.id });
    expect(code(await run(session(), { onboarding_id: theirs.id }))).toBe("not_found");
    expect(code(await run(session(), { onboarding_id: "nope" }))).toBe("not_found");
    expect((await getOnboarding(db, { orgId: other.id }, theirs.id))?.firstRunId).toBeNull();
  });

  test("a project that is not ingested is refused with a reason", async () => {
    const r = await run(session());
    expect(code(r)).toBe("not_found");
  });
});
