// instance_prune_unconfigured_projects (#577): lists, and deletes, the projects an installation
// sync made that nobody set up, and never one that has a run, a setting, a poll entry, a
// credential or any other row of its own. Runs on both dialects with TURNTABLE_TEST_DB.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  bindRepo,
  createOrg,
  createProject,
  createRun,
  getProjectBySlug,
  listAudit,
  listProjects,
  listRuns,
  openDatabase,
  setProjectSandboxSettings,
  type Db,
} from "../src/db";
import { createOnboarding, putStoredSetting, setProjectIngest } from "../src/db/repos";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { mintToken } from "./ops-helpers";

let db: Db;
let orgId: string;
let env: DispatchEnv;
let secret: string;

/** A project the way an old installation sync made it: bound through an installation, paused. */
async function syncMade(slug: string, repoId: string) {
  const p = await createProject(db, { orgId }, { slug, name: `acme/${slug}`, maxConcurrent: 0 });
  await bindRepo(
    db,
    { orgId, projectId: p.id },
    { forge: "github", owner: "acme", repo: slug, installationId: "100", forgeRepoId: repoId },
  );
  return { orgId, projectId: p.id };
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  orgId = (await createOrg(db, { slug: "acme", name: "Acme" })).id;
  env = {
    registry,
    db,
    allowInstance: true,
    staticPollProjects: ["acme/polled"],
  };
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

const prune = (input: Record<string, unknown>, cred: string = secret) =>
  dispatch(env, { kind: "bearer", token: cred }, "instance_prune_unconfigured_projects", input);
type Out = { count: number; projects: { slug: string; repos: string[] }[]; dry_run: boolean };

/** One qualifying project and one of each kind that must never be listed. */
async function world() {
  await syncMade("idle-a", "1");
  await syncMade("idle-b", "2");
  const withRun = await syncMade("has-run", "3");
  await createRun(db, withRun, { workflowPath: "ci.yml", event: "push", ref: "refs/heads/main" });
  const withIngest = await syncMade("has-ingest", "4");
  await setProjectIngest(db, withIngest, "{}");
  const withCap = await syncMade("has-cap", "5");
  await setProjectSandboxSettings(db, withCap, { maxConcurrent: 3 });
  const withSetting = await syncMade("has-setting", "6");
  await putStoredSetting(
    db,
    { kind: "project", id: withSetting.projectId, orgId },
    "checks_mode",
    "shadow",
    "t",
    1,
  );
  await syncMade("polled", "7");
  const withToken = await syncMade("has-token", "8");
  await mintToken(db, withToken, "reader");
  const onboarded = await syncMade("has-onboarding", "9");
  const tok = await mintToken(db, onboarded, "reader");
  await createOnboarding(db, { orgId }, { installationId: "100" });
  void tok;
  // added on purpose: never listed, even with nothing else
  const added = await createProject(
    db,
    { orgId },
    { slug: "added", name: "acme/added", addedAt: 1 },
  );
  await bindRepo(
    db,
    { orgId, projectId: added.id },
    { forge: "github", owner: "acme", repo: "added", installationId: "100", forgeRepoId: "10" },
  );
  // made by hand, never bound through an installation
  await createProject(db, { orgId }, { slug: "manual", name: "manual" });
}

describe("instance_prune_unconfigured_projects", () => {
  test("the dry run lists exactly the qualifying projects and changes nothing", async () => {
    await world();
    const before = (await listProjects(db, { orgId })).length;
    const r = await prune({ target_org: "acme", dry_run: true });
    expect(r.ok).toBe(true);
    const out = (r as { output: Out }).output;
    expect(out.dry_run).toBe(true);
    expect(out.projects.map((p) => p.slug)).toEqual(["idle-a", "idle-b"]);
    expect(out.projects[0]!.repos).toEqual(["acme/idle-a"]);
    expect(out.count).toBe(2);
    expect((await listProjects(db, { orgId })).length).toBe(before);
  });

  test("a non-dry run needs expected_count, refuses a changed list, and deletes the listed projects", async () => {
    await world();
    const noCount = await prune({ target_org: "acme", dry_run: false });
    expect(noCount.ok ? "ok" : noCount.error.code).toBe("invalid_input");
    const wrong = await prune({ target_org: "acme", dry_run: false, expected_count: 3 });
    expect(wrong.ok ? "ok" : wrong.error.code).toBe("conflict");
    expect(await getProjectBySlug(db, { orgId }, "idle-a")).toBeDefined();

    const r = await prune({ target_org: "acme", dry_run: false, expected_count: 2 });
    expect(r.ok).toBe(true);
    expect((r as { output: Out }).output.projects.map((p) => p.slug)).toEqual(["idle-a", "idle-b"]);
    const left = (await listProjects(db, { orgId })).map((p) => p.slug).toSorted();
    expect(left).toEqual([
      "added",
      "has-cap",
      "has-ingest",
      "has-onboarding",
      "has-run",
      "has-setting",
      "has-token",
      "manual",
      "polled",
    ]);
    expect(await listRuns(db, await scopeOf("has-run"))).toHaveLength(1);
    // a second run of the same call finds nothing left
    const again = await prune({ target_org: "acme", dry_run: true });
    expect((again as { output: Out }).output.count).toBe(0);
  });

  test("each deletion is audited in the system chain and in the org chain, with slug and repo", async () => {
    await world();
    await prune({ target_org: "acme", dry_run: false, expected_count: 2 });
    for (const chain of [orgId, await systemOrgId(db)]) {
      const rows = (await listAudit(db, { orgId: chain })).filter(
        (a) => a.op === "instance_prune_unconfigured_projects" && JSON.parse(a.input).project,
      );
      expect(rows.map((a) => JSON.parse(a.input).project).toSorted()).toEqual(["idle-a", "idle-b"]);
      const a = rows.find((r) => JSON.parse(r.input).project === "idle-a")!;
      expect(JSON.parse(a.input).repos).toEqual(["acme/idle-a"]);
    }
  });

  test("the system org, an unknown org, an org token and a missing instance token are refused", async () => {
    await world();
    expect((await prune({ target_org: "nope", dry_run: true })).ok).toBe(false);
    expect((await prune({ target_org: "system", dry_run: true })).ok).toBe(false);
    const org = await mintToken(db, { orgId }, "reader");
    expect((await prune({ target_org: "acme", dry_run: true }, org.secret)).ok).toBe(false);
    expect((await prune({ target_org: "acme", dry_run: true }, "tti_nope")).ok).toBe(false);
  });

  test("another org's projects are never listed or deleted", async () => {
    await world();
    const other = await createOrg(db, { slug: "other", name: "Other" });
    await createProject(
      db,
      { orgId: other.id },
      { slug: "theirs", name: "theirs", maxConcurrent: 0 },
    );
    const r = await prune({ target_org: "acme", dry_run: false, expected_count: 2 });
    expect(r.ok).toBe(true);
    expect((await listProjects(db, { orgId: other.id })).map((p) => p.slug)).toEqual(["theirs"]);
  });

  test("it is not an MCP tool", () => {
    expect(registry.get("instance_prune_unconfigured_projects")?.mcp).toBe(false);
  });
});

async function scopeOf(slug: string) {
  return { orgId, projectId: (await getProjectBySlug(db, { orgId }, slug))!.id };
}
