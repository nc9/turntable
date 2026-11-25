// Sandbox limits as live settings (#661): the scheduler's caps and the Daytona provider's limits
// change through `instance_set_setting` and take effect on the next claim, with no restart.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { systemOrgId } from "../src/audit/failures";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  listAudit,
  openDatabase,
  type Scope,
} from "../src/db";
import { checkLimitLocks } from "../src/doctor/checks";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { DrainState, Scheduler, type AttemptRunner } from "../src/scheduler";
import {
  providerDaytonaCpuLimitSetting,
  providerDaytonaMaxLiveSetting,
  schedulerGlobalCapSetting,
  schedulerOrgCapSetting,
  settingsRegistry,
} from "../src/settings/definitions";
import { createSettingsRuntime, resolveSetting } from "../src/settings/resolve";

let db: Db;
let world: FakeWorld;
let org: { orgId: string; scope: Required<Scope> };
let env: DispatchEnv;
let secret: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const o = await createOrg(db, { slug: "org-a", name: "org-a" });
  const p = await createProject(db, { orgId: o.id }, { slug: "app", name: "app" });
  org = { orgId: o.id, scope: { orgId: o.id, projectId: p.id } };
  world = new FakeWorld();
  env = {
    registry,
    db,
    allowInstance: true,
    settings: createSettingsRuntime(settingsRegistry),
  };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});
afterEach(() => world.dispose());

const asInstance = (op: string, input: Record<string, unknown>, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, op, input);
const setKey = (key: string, value: unknown, e: DispatchEnv = env) =>
  asInstance("instance_set_setting", { key, value }, e);

let n = 0;
async function queueJob() {
  const run = await createRun(db, org.scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, org.scope, {
    runId: run.id,
    jobKey: `j${n++}`,
    name: "j",
  }))!;
  await createAttempt(db, org.scope, { jobId: job.id, provider: "fake" });
}

/** A scheduler with NO cap options, so the caps are the live settings. Its runners wait on `gate`. */
function holdingScheduler(gate: Promise<void>, aborted: { v: boolean }) {
  const runner: AttemptRunner = async (ctx) => {
    ctx.signal.addEventListener("abort", () => (aborted.v = true));
    await gate;
    return { state: "success", reason: "ok" };
  };
  return new Scheduler({
    db,
    runner,
    providers: () => world.provider(),
    drain: new DrainState(),
    settings: env.settings!,
  });
}

describe("scheduler caps", () => {
  test("raising scheduler_global_cap lets the next claim through with no restart", async () => {
    expect((await setKey("scheduler_org_cap", 50)).ok).toBe(true);
    expect((await setKey("scheduler_global_cap", 1)).ok).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sched = holdingScheduler(gate, { v: false });
    await queueJob();
    await queueJob();
    expect(await sched.tick()).toBe(1);
    expect(await sched.tick()).toBe(0); // at the cap: the second waits
    expect((await setKey("scheduler_global_cap", 2)).ok).toBe(true);
    expect(await sched.tick()).toBe(1); // the same scheduler, no reboot
    release();
    await sched.stop();
  });

  test("lowering a cap below current usage cancels nothing and holds new claims", async () => {
    expect((await setKey("scheduler_org_cap", 50)).ok).toBe(true);
    expect((await setKey("scheduler_global_cap", 2)).ok).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const aborted = { v: false };
    const sched = holdingScheduler(gate, aborted);
    await queueJob();
    await queueJob();
    expect(await sched.tick()).toBe(2);
    expect((await setKey("scheduler_global_cap", 1)).ok).toBe(true);
    await queueJob();
    expect(await sched.tick()).toBe(0);
    expect(sched.activeCount).toBe(2);
    expect(aborted.v).toBe(false);
    release();
    for (let i = 0; i < 100 && sched.activeCount > 0; i++) await Bun.sleep(10);
    expect(await sched.tick()).toBe(1); // usage is under the cap again
    await sched.stop();
  });

  test("an explicit cap option still wins (turntable run, tests)", async () => {
    const sched = new Scheduler({
      db,
      runner: async () => ({ state: "success", reason: "ok" }),
      providers: () => world.provider(),
      drain: new DrainState(),
      globalCap: 1,
      perOrgCap: 1,
      settings: env.settings!,
    });
    await queueJob();
    await queueJob();
    expect(await sched.tick()).toBeGreaterThanOrEqual(1);
    await sched.stop();
  });
});

describe("locks", () => {
  const locked = (vars: Record<string, string>): DispatchEnv => ({
    ...env,
    settings: createSettingsRuntime(settingsRegistry, vars),
  });

  test("an env value locks the setting and set_setting names the variable", async () => {
    const e = locked({ TURNTABLE_GLOBAL_CAP: "3", TURNTABLE_ORG_CAP: "3" });
    const r = await setKey("scheduler_global_cap", 5, e);
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toContain("TURNTABLE_GLOBAL_CAP");
    const g = await asInstance("instance_get_setting", { key: "scheduler_global_cap" }, e);
    expect(g.ok && g.output).toMatchObject({
      value: 3,
      source: "env",
      locked: true,
      locked_by: "TURNTABLE_GLOBAL_CAP",
    });
    // The scheduler reads the locked value.
    expect((await resolveSetting(e.settings!, db, schedulerGlobalCapSetting.key)).value).toBe(3);
  });

  test("the provider config document locks the provider limits it sets, and only those", async () => {
    const e = locked({
      TURNTABLE_PROVIDER_CONFIG_JSON: JSON.stringify({
        maxLive: 3,
        ownerCiPreflight: { cpuLimit: 80 },
      }),
    });
    const rt = e.settings!;
    expect(await resolveSetting(rt, db, providerDaytonaMaxLiveSetting.key)).toMatchObject({
      value: 3,
      locked: true,
      origin: "TURNTABLE_PROVIDER_CONFIG_JSON",
    });
    expect((await resolveSetting(rt, db, providerDaytonaCpuLimitSetting.key)).value).toBe(80);
    const noLimits = createSettingsRuntime(settingsRegistry, {
      TURNTABLE_PROVIDER_CONFIG_JSON: JSON.stringify({ snapshot: "base" }),
    });
    expect((await resolveSetting(noLimits, db, providerDaytonaMaxLiveSetting.key)).locked).toBe(
      false,
    );
    expect((await setKey("provider_daytona_max_live", 4, e)).ok).toBe(false);
  });

  test("doctor warns about a limit locked by an environment variable, naming it", () => {
    const base = { env: { TURNTABLE_GLOBAL_CAP: "3" } } as never;
    const c = checkLimitLocks(base);
    expect(c.status).toBe("warn");
    expect(c.summary).toContain("scheduler_global_cap is locked by TURNTABLE_GLOBAL_CAP");
    expect(checkLimitLocks({ env: {} } as never).status).toBe("pass");
  });
});

describe("set_quotas and the live org cap", () => {
  test("refuses max_concurrent above the live scheduler_org_cap, and follows a change", async () => {
    const quota = (v: number) =>
      asInstance("set_quotas", { target_org: "org-a", max_concurrent: v });
    const refused = await quota(3); // the default cap is 2
    expect(!refused.ok && refused.error.code).toBe("invalid_input");
    expect(!refused.ok && refused.error.message).toContain("per-org cap of 2");
    expect((await setKey("scheduler_org_cap", 6)).ok).toBe(true);
    expect((await quota(5)).ok).toBe(true);
    expect((await quota(7)).ok).toBe(false);
  });
});

describe("surfaces and audit", () => {
  test("the limits are instance settings over REST, never MCP tools, and are audited with old and new", async () => {
    const list = await asInstance("instance_list_settings", {});
    const keys = list.ok
      ? (list.output as { settings: { key: string }[] }).settings.map((s) => s.key)
      : [];
    for (const d of [
      schedulerGlobalCapSetting,
      schedulerOrgCapSetting,
      providerDaytonaMaxLiveSetting,
      providerDaytonaCpuLimitSetting,
    ]) {
      expect(keys).toContain(d.key);
      expect(d.scope).toBe("instance");
    }
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_set_setting");
    expect((await setKey("scheduler_global_cap", 9)).ok).toBe(true);
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const row = rows.find(
      (r) => r.op === "setting_changed" && r.input.includes("scheduler_global_cap"),
    );
    expect(row).toBeDefined();
    const input = JSON.parse(row!.input) as { from: unknown; to: unknown };
    expect(input).toMatchObject({ from: 4, to: 9 });
  });

  test("values outside the range are refused", async () => {
    expect((await setKey("scheduler_global_cap", 0)).ok).toBe(false);
    expect((await setKey("provider_daytona_max_live", 11)).ok).toBe(false);
    expect((await setKey("provider_daytona_cpu_limit", "many")).ok).toBe(false);
  });
});
