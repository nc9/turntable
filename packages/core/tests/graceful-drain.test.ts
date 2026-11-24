// Graceful drain (#446): no new attempt starts while draining, running ones finish, a shutdown that
// times out leaves its attempts for the next boot (re-attach, else one infra retry), the drain is
// never persisted, /healthz and doctor report it, and the op is the instance administrator's alone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { systemOrgId } from "../src/audit/failures";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createRun,
  type Db,
  getJob,
  listAttempts,
  listAudit,
  markDrainCut,
  type Scope,
} from "../src/db";
import { checkDraining } from "../src/doctor/checks";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import {
  DrainState,
  processDrain,
  reconcileExpired,
  resetProcessDrain,
  Scheduler,
  type AttemptRunner,
} from "../src/scheduler";
import { handleRequest } from "../src/server";
import { drainTimeoutSecondsSetting, settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { VERSION } from "../src/version";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let world: FakeWorld;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  world = new FakeWorld();
  resetProcessDrain();
});

afterEach(() => {
  world.dispose();
  resetProcessDrain();
  processDrain.trackRunning(() => 0);
});

/** One run with one queued job and attempt. */
async function queueJob(scope: Required<Scope>, key = "build") {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { run, job, attempt };
}

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe("the scheduler", () => {
  test("drain on: nothing new is claimed while a running attempt completes; drain off resumes", async () => {
    const first = await queueJob(a.scope, "first");
    const g = gate();
    const started: string[] = [];
    const runner: AttemptRunner = async (ctx) => {
      started.push(ctx.job.jobKey);
      await g.p;
      return { state: "success", reason: "ok" };
    };
    const drain = new DrainState();
    const sched = new Scheduler({
      db,
      runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
    });
    expect(await sched.tick()).toBe(1);
    const second = await queueJob(a.scope, "second");

    drain.set(true, "deploy", T0);
    expect(await sched.tick()).toBe(0);
    expect(sched.activeCount).toBe(1);
    expect((await getJob(db, a.scope, second.job.id))?.state).toBe("queued");

    g.open();
    await sched.idle();
    expect((await getJob(db, a.scope, first.job.id))?.state).toBe("success");
    // queued work stays queued while draining, even with nothing running
    expect(await sched.tick()).toBe(0);
    expect((await getJob(db, a.scope, second.job.id))?.state).toBe("queued");

    drain.set(false, "", T0);
    expect(await sched.tick()).toBe(1);
    await sched.idle();
    expect((await getJob(db, a.scope, second.job.id))?.state).toBe("success");
  });

  test("the timeout path marks what still runs as cut, without aborting it", async () => {
    const q = await queueJob(a.scope);
    const g = gate();
    let aborted = false;
    const runner: AttemptRunner = async (ctx) => {
      ctx.signal.addEventListener("abort", () => (aborted = true));
      await g.p;
      return { state: "success", reason: "ok" };
    };
    const sched = new Scheduler({
      db,
      runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain: new DrainState(),
    });
    expect(await sched.tick()).toBe(1);
    const { remaining } = await sched.drainAndWait(30);
    expect(remaining).toBe(1);
    expect(aborted).toBe(false);
    const att = (await listAttempts(db, a.scope, q.job.id))[0]!;
    expect(att).toMatchObject({ state: "running", errorClass: "drain_cut" });
    g.open();
    await sched.idle();
  });

  test("drainAndWait returns 0 remaining when the attempts finish inside the timeout", async () => {
    const q = await queueJob(a.scope);
    const sched = new Scheduler({
      db,
      runner: async () => {
        await Bun.sleep(20);
        return { state: "success", reason: "ok" };
      },
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain: new DrainState(),
    });
    await sched.tick();
    expect(await sched.drainAndWait(10_000)).toEqual({ remaining: 0 });
    expect((await getJob(db, a.scope, q.job.id))?.state).toBe("success");
  });
});

describe("restart recovery of an attempt a drain cut", () => {
  const claim = (owner: string) =>
    claimNextAttempt(db, {
      owner,
      leaseMs: 1000,
      now: T0,
      globalCap: 100,
      perOrgCap: 100,
    });
  const probe = () => reconcileExpired(db, () => world.provider(), { now: () => T0 + 5000 });

  test("a vanished sandbox: infra_error on the old attempt, the job requeued once, never a failure", async () => {
    const q = await queueJob(a.scope);
    await claim("old");
    expect(await markDrainCut(db, a.scope, q.attempt.id, "old")).toBe(true);

    const rep = await probe();
    expect(rep.resolved).toHaveLength(1);
    const attempts = await listAttempts(db, a.scope, q.job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "infra_error", leaseOwner: null });
    expect(attempts[0]!.errorClass).toStartWith("controller_lost");
    expect(attempts[1]).toMatchObject({ state: "queued" });
    expect((await getJob(db, a.scope, q.job.id))?.state).toBe("queued");

    // the retry runs; if a second drain cuts it too, the job ends as infra_error and is not requeued again
    await claim("old2");
    expect(await markDrainCut(db, a.scope, attempts[1]!.id, "old2")).toBe(true);
    await probe();
    const after = await listAttempts(db, a.scope, q.job.id);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ state: "infra_error" });
    expect((await getJob(db, a.scope, q.job.id))?.state).toBe("infra_error");
  });

  test("an attempt that was not cut by a drain is not requeued (a crash keeps its old behaviour)", async () => {
    const q = await queueJob(a.scope);
    await claim("old");
    await probe();
    expect(await listAttempts(db, a.scope, q.job.id)).toHaveLength(1);
    expect((await getJob(db, a.scope, q.job.id))?.state).toBe("infra_error");
  });

  test("markDrainCut is fenced by the lease holder and by the running state", async () => {
    const q = await queueJob(a.scope);
    expect(await markDrainCut(db, a.scope, q.attempt.id, "nobody")).toBe(false);
    await claim("old");
    expect(await markDrainCut(db, a.scope, q.attempt.id, "someone-else")).toBe(false);
    expect(await markDrainCut(db, a.scope, q.attempt.id, "old")).toBe(true);
  });
});

describe("boot, healthz and doctor", () => {
  test("a boot is undrained: the drain is process memory, not stored", async () => {
    processDrain.set(true, "deploy", T0);
    expect(processDrain.draining).toBe(true);
    // a new process has a fresh state; nothing in the database carries the flag
    expect(new DrainState().snapshot()).toEqual({ draining: false, since: null, reason: null });
    resetProcessDrain();
    expect(processDrain.snapshot().draining).toBe(false);
    const q = await queueJob(a.scope);
    const sched = new Scheduler({
      db,
      runner: async () => ({ state: "success", reason: "ok" }),
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
    });
    expect(await sched.tick()).toBe(1);
    await sched.idle();
    expect((await getJob(db, a.scope, q.job.id))?.state).toBe("success");
  });

  test("turning it on twice keeps the first time and reason", () => {
    const d = new DrainState();
    d.set(true, "first", 10);
    d.set(true, "second", 20);
    expect(d.snapshot()).toEqual({ draining: true, since: 10, reason: "first" });
  });

  test("/healthz stays 200 while draining and carries draining and the running count", async () => {
    const plain = await handleRequest(new Request("http://localhost/healthz"));
    expect(await plain.json()).toEqual({ ok: true, version: VERSION });
    processDrain.trackRunning(() => 3);
    processDrain.set(true, "deploy", T0);
    const res = await handleRequest(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: VERSION,
      draining: true,
      running_attempts: 3,
    });
  });

  test("doctor reports draining as a warning with a fixed sentence", () => {
    expect(checkDraining()).toMatchObject({ id: "draining", status: "pass" });
    processDrain.set(true, "deploy", T0);
    const c = checkDraining();
    expect(c).toMatchObject({ id: "draining", status: "warn" });
    expect(c.summary).toBe("the scheduler is draining: no new attempt starts until the drain ends");
    expect(c.detail).toBeUndefined();
  });
});

describe("instance_drain and instance_drain_status", () => {
  let env: DispatchEnv;
  let secret: string;
  let clock: number;
  beforeEach(async () => {
    clock = 1_800_000_000_000;
    env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => clock };
    secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  });
  const asInstance = (name: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "bearer", token: secret }, name, input);

  test("on, status, off: the output has draining, running_attempts and since", async () => {
    const on = await asInstance("instance_drain", { on: true, reason: "deploy abc123" });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.output).toEqual({
      draining: true,
      running_attempts: 0,
      since: new Date(clock).toISOString(),
    });
    const status = await asInstance("instance_drain_status");
    expect(status.ok && status.output).toEqual(on.output);
    const off = await asInstance("instance_drain", { on: false, reason: "deploy done" });
    expect(off.ok && off.output).toEqual({ draining: false, running_attempts: 0, since: null });
  });

  test("running_attempts counts running attempts across the instance", async () => {
    await queueJob(a.scope);
    await claimNextAttempt(db, { owner: "w", leaseMs: 1000, now: T0, globalCap: 9, perOrgCap: 9 });
    const r = await asInstance("instance_drain_status");
    expect(r.ok && (r.output as { running_attempts: number }).running_attempts).toBe(1);
  });

  test("a reason is required", async () => {
    const r = await asInstance("instance_drain", { on: true, reason: "x" });
    expect(r.ok).toBe(false);
    expect(processDrain.draining).toBe(false);
  });

  test("it is audited in the system chain", async () => {
    await asInstance("instance_drain", { on: true, reason: "deploy abc123" });
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const row = rows.find((x) => x.op === "instance_drain");
    expect(row).toMatchObject({ effect: "write", outcome: "ok" });
    expect(row!.input).toContain("deploy abc123");
  });

  test("tti_ only, REST only: org tokens and MCP are refused", async () => {
    for (const op of ["instance_drain", "instance_drain_status"]) {
      const def = registry.ops.find((o) => o.name === op)!;
      expect(def.mcp).toBe(false);
      expect(def.auth.type).toBe("instance");
      expect(mcpTools(registry).map((t) => t.name)).not.toContain(op);
    }
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const tok = (await mintToken(db, { orgId: a.orgId }, role)).secret;
      const r = await dispatch(env, { kind: "bearer", token: tok }, "instance_drain", {
        on: true,
        reason: "sneaky",
      });
      expect(r.ok, role).toBe(false);
      if (!r.ok) expect(r.error.code, role).toBe("forbidden");
    }
    expect(processDrain.draining).toBe(false);
  });
});

describe("drain_timeout_seconds", () => {
  let env: DispatchEnv;
  let secret: string;
  beforeEach(async () => {
    env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
    secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  });
  const set = (value: unknown, e: DispatchEnv = env) =>
    dispatch(e, { kind: "bearer", token: secret }, "instance_set_setting", {
      key: "drain_timeout_seconds",
      value,
    });

  test("defaults to 600 and is an instance-admin-only setting", () => {
    expect(drainTimeoutSecondsSetting.default).toBe(600);
    expect(drainTimeoutSecondsSetting.instanceAdminOnly).toBe(true);
  });

  test("range 0 to 3600 is validated", async () => {
    expect((await set(-1)).ok).toBe(false);
    expect((await set(3601)).ok).toBe(false);
    expect((await set(1.5)).ok).toBe(false);
    expect((await set("ten")).ok).toBe(false);
    expect((await set(0)).ok).toBe(true);
    expect((await set(3600)).ok).toBe(true);
  });

  test("an env value locks it, and a bad env value is rejected", async () => {
    const locked = await set(30, {
      ...env,
      settings: createSettingsRuntime(settingsRegistry, { TURNTABLE_DRAIN_TIMEOUT_SECONDS: "45" }),
    });
    expect(!locked.ok && locked.error.code).toBe("conflict");
    expect(drainTimeoutSecondsSetting.envParse?.("45")).toBe(45);
    expect(
      drainTimeoutSecondsSetting.type.safeParse(drainTimeoutSecondsSetting.envParse?.("9999"))
        .success,
    ).toBe(false);
  });
});
