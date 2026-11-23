// `untrusted_run_approval` on the settings registry (#321): the resolver's layers decide who may
// approve, a turntable.toml value locks it for every path, and `set_setting`, `set_project_settings`
// and `turntable policy set` refuse the same things. Runs on both dialects (TURNTABLE_TEST_DB).
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createJob, createRun, type Db, listAudit } from "../src/db";
import { putStoredSetting } from "../src/db/repos/settings";
import { UNTRUSTED_RUN_APPROVALS } from "../src/db/schema";
import { dispatch, type Credential, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { setSandboxPolicy } from "../src/ops/policy-cli";
import { settingsRegistry, untrustedRunApprovalSetting } from "../src/settings/definitions";
import { loadSettingsRuntime } from "../src/settings/boot";
import { resolveSetting, type SettingsRuntime } from "../src/settings/resolve";
import { SettingsConfigError } from "../src/settings/toml";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let instanceSecret: string;

const KEY = "untrusted_run_approval";
const rt = (toml?: string, env: Record<string, string> = {}): SettingsRuntime =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env,
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });
const lock = (policy: string, org = "org-a", project = "app") =>
  rt(`[orgs.${org}.projects.${project}]\n${KEY} = "${policy}"\n`);

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  instanceSecret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

const asInstance = (settings: SettingsRuntime, input: Record<string, unknown>) =>
  dispatch(
    { registry, db, settings, allowInstance: true } as DispatchEnv,
    { kind: "bearer", token: instanceSecret },
    "set_project_settings",
    { target_org: "org-a", target_project: "app", ...input },
  );

async function asToken(
  settings: SettingsRuntime,
  op: string,
  input: Record<string, unknown>,
  opts: { transport?: "mcp" | "rest"; viaMcp?: boolean; kind?: "agent" | "person" } = {},
) {
  const { secret } = await mintToken(db, a.scope, "release_operator", {
    kind: opts.kind ?? "person",
  });
  return dispatch(
    { registry, db, settings, ...(opts.viaMcp ? { transport: "mcp" as const } : {}) },
    { kind: "bearer", token: secret } as Credential,
    op,
    input,
  );
}

async function held(tenant: Tenant) {
  const sha = createHash("sha1").update(`held-${tenant.orgId}`).digest("hex");
  const workflowHash = createHash("sha256").update(`wf-${tenant.orgId}`).digest("hex");
  const run = await createRun(db, tenant.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    ref: "refs/pull/7/head",
    sha,
    trust: JSON.stringify({ class: "untrusted_pr", workflowHash }),
  });
  const job = (await createJob(db, tenant.scope, {
    runId: run.id,
    jobKey: "build",
    name: "build",
    approvalKind: "untrusted_author",
  }))!;
  await db.run((h) =>
    rawExec(h.orm, sql`update jobs set state = 'awaiting_approval' where id = ${job.id}`),
  );
  return { run_id: run.id, head_sha: sha, workflow_hash: workflowHash };
}

describe("the definition", () => {
  test("is a project setting, MCP may not edit it, only the instance administrator may, and has no env var", () => {
    const d = settingsRegistry.get(KEY)!;
    expect(d).toMatchObject({
      scope: "project",
      default: "no_agents",
      mcpEditable: false,
      instanceAdminOnly: true,
      env: [],
      toml: "untrusted_run_approval",
    });
    expect(UNTRUSTED_RUN_APPROVALS.every((v) => d.type.safeParse(v).success)).toBe(true);
    expect(d.type.safeParse("all").success).toBe(false);
  });
});

describe("precedence", () => {
  const subject = () => ({
    orgId: a.orgId,
    orgSlug: "org-a",
    projectId: a.projectId,
    projectSlug: a.projectSlug,
  });
  test("default, then db, then toml", async () => {
    const plain = rt();
    expect(await resolveSetting(plain, db, KEY, subject())).toMatchObject({
      value: "no_agents",
      source: "default",
    });
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    expect(await resolveSetting(plain, db, KEY, subject())).toMatchObject({
      value: "any",
      source: "db",
    });
    const locked = await resolveSetting(
      lock("no_agents", "org-a", a.projectSlug),
      db,
      KEY,
      subject(),
    );
    expect(locked).toMatchObject({ value: "no_agents", source: "toml", locked: true });
  });

  test("a toml lock decides approve_run, and only for its own project", async () => {
    // the database says any; the file says no_agents for org-a's project
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    const input = await held(a);
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const r = await asToken(settings, "approve_run", input, { kind: "agent" });
    expect(!r.ok && r.error.message).toMatch(/agents_may_not_approve/);
    // without the lock the stored `any` lets the agent approve
    const ok = await asToken(rt(), "approve_run", input, { kind: "agent" });
    expect(ok.ok).toBe(true);
  });

  test("a toml value for org-a's project does not reach org-b's", async () => {
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const other = await resolveSetting(settings, db, KEY, {
      orgId: b.orgId,
      orgSlug: "org-b",
      projectId: b.projectId,
      projectSlug: b.projectSlug,
    });
    expect(other).toMatchObject({ source: "default", locked: false });
  });
});

describe("a toml lock refuses every way in, naming the file", () => {
  test("set_setting, set_project_settings and the host CLI", async () => {
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const viaSet = await asToken(settings, "set_setting", { key: KEY, value: "any" });
    expect(!viaSet.ok && viaSet.error.message).toMatch(/locked.*turntable\.toml/);
    const viaAlias = await asInstance(settings, {
      target_project: a.projectSlug,
      untrusted_run_approval: "any",
    });
    expect(!viaAlias.ok && viaAlias.error.message).toMatch(/locked.*turntable\.toml/);
    await expect(
      setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "any" }, settings),
    ).rejects.toThrow(/locked.*turntable\.toml/);
    // nothing was written
    expect(
      (await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId })).source,
    ).toBe("default");
  });

  test("get_project_settings shows the locked value, not the stored one", async () => {
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    const r = await asToken(lock("no_agents", "org-a", a.projectSlug), "get_project_settings", {});
    expect(r.ok && (r.output as { untrusted_run_approval: string }).untrusted_run_approval).toBe(
      "no_agents",
    );
  });
});

describe("the same refusals on every path", () => {
  test("set_setting by an org token is refused: only the instance administrator raises it", async () => {
    const r = await asToken(rt(), "set_setting", { key: KEY, value: "any" });
    expect(!r.ok && r.error.message).toBe(`only the instance administrator can change ${KEY}`);
  });

  test("set_setting refuses an admin token of the project's own org, and the lock is reported first", async () => {
    const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
    const env = { registry, db, settings: rt() } as DispatchEnv;
    const r = await dispatch(env, { kind: "bearer", token: secret }, "set_setting", {
      key: KEY,
      value: "any",
    });
    expect(!r.ok && r.error.message).toMatch(/only the instance administrator/);
    const locked = await dispatch(
      { ...env, settings: lock("no_agents", "org-a", a.projectSlug) },
      { kind: "bearer", token: secret },
      "set_setting",
      { key: KEY, value: "any" },
    );
    expect(!locked.ok && locked.error.message).toMatch(/locked/);
  });

  test("instance_set_setting sets it on a project of org A with target_org and target_project", async () => {
    const r = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, value: "any", target_org: "org-a", target_project: a.projectSlug },
    );
    expect(r.ok).toBe(true);
    expect(
      await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId }),
    ).toMatchObject({ value: "any", source: "db" });
    // org B's project is untouched
    expect(
      await resolveSetting(rt(), db, KEY, { orgId: b.orgId, projectId: b.projectId }),
    ).toMatchObject({ value: "no_agents", source: "default" });
    const missing = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, value: "any", target_org: "org-a" },
    );
    expect(!missing.ok && missing.error.message).toMatch(/target_project/);
  });

  test("instance_set_setting is not reachable by org A's admin token or over MCP", async () => {
    const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
    const input = { key: KEY, value: "any", target_org: "org-a", target_project: a.projectSlug };
    const viaOrg = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: secret },
      "instance_set_setting",
      input,
    );
    expect(viaOrg.ok).toBe(false);
    const viaMcp = await dispatch(
      { registry, db, settings: rt(), allowInstance: true, viaMcp: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      input,
    );
    expect(viaMcp.ok).toBe(false);
    expect(
      (await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId })).source,
    ).toBe("default");
  });

  test("set_setting over MCP is refused with the reason", async () => {
    const r = await asToken(rt(), "set_setting", { key: KEY, value: "any" }, { viaMcp: true });
    expect(r.ok).toBe(false);
  });

  test("selecting human is refused by the registry: op, alias, CLI, toml and env", async () => {
    const inst = await asInstance(rt(), {
      target_project: a.projectSlug,
      untrusted_run_approval: "human",
    });
    expect(!inst.ok && inst.error.message).toMatch(/isn't available yet \(#324\)/);
    await expect(
      setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "human" }),
    ).rejects.toThrow(/isn't available yet \(#324\)/);
    expect(untrustedRunApprovalSetting.refuse?.("human")).toMatch(/#324/);
    expect(() => lock("human", "org-a", a.projectSlug)).toThrow(SettingsConfigError);
  });

  test("the alias writes through to the settings table and audits old and new", async () => {
    const r = await asInstance(rt(), {
      target_project: a.projectSlug,
      untrusted_run_approval: "any",
    });
    expect(r.ok).toBe(true);
    const got = await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId });
    expect(got).toMatchObject({ value: "any", source: "db" });
    const row = (await listAudit(db, { orgId: a.orgId }, { limit: 10 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(JSON.parse(row!.input)).toMatchObject({
      from: { untrustedRunApproval: "no_agents" },
      to: { untrustedRunApproval: "any" },
    });
  });
});

describe("cross-tenant", () => {
  test("a value stored for org-a's project is invisible to org-b's, and a token cannot write another org's", async () => {
    await asInstance(rt(), { target_project: a.projectSlug, untrusted_run_approval: "any" });
    const seenByB = await resolveSetting(rt(), db, KEY, { orgId: b.orgId, projectId: b.projectId });
    expect(seenByB).toMatchObject({ value: "no_agents", source: "default" });
    // a project of org-a cannot be filed under org-b
    await expect(
      putStoredSetting(
        db,
        { kind: "project", id: a.projectId, orgId: b.orgId },
        KEY,
        "any",
        "t",
        1,
      ),
    ).rejects.toThrow(/not in org/);
  });
});
