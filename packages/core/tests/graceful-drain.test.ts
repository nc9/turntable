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
  createOrg,
  createProject,
  type Db,
  getJob,
  listAttempts,
  listAudit,
  listEvents,
  markDrainCut,
  recordTrustClass,
  updateAttempt,
  upsertStep,
  openDatabase,
  type Scope,
  setProjectChecksMode,
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
import { BUILD_SHA, BUILD_TIME, VERSION } from "../src/version";
import { mintToken } from "./ops-helpers";

let db: Db;
// One org with one project and nothing queued: seedWorld would add a queued attempt per tenant,
// which the scheduler and the claim tests below would pick up.
let a: { orgId: string; scope: Required<Scope> };
let world: FakeWorld;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "org-a", name: "org-a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  a = { orgId: org.id, scope: { orgId: org.id, projectId: project.id } };
  world = new FakeWorld();
  resetProcessDrain();
});

afterEach(() => {
  world.dispose();
  resetProcessDrain();
  processDrain.trackRunning(() => 0);
  processDrain.trackShadowCutter(async () => 0);
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

  // #565: the requeue follows the infra-retry rule: a pull request job once, any other class only
  // when it was cut before its first step started.
  describe("the drain-cut rule (#565)", () => {
    const NOT_RETRIED =
      "cut by a drain after steps started; not retried for a protected or release job: rerun it by hand";
    // `launch`: how far the runner got. "none" = cut while the sandbox was being created;
    // "exec" = sandbox and exec recorded (the step rows may lag, so none is not proof).
    async function cutJob(
      klass: string | null,
      stepsStarted: boolean,
      launch: "none" | "sandbox" | "exec" = stepsStarted ? "exec" : "none",
    ) {
      const q = await queueJob(a.scope);
      await claim("old");
      if (klass) expect(await recordTrustClass(db, a.scope, q.attempt.id, "old", klass)).toBe(true);
      if (launch !== "none") {
        await updateAttempt(db, a.scope, q.attempt.id, {
          sandboxId: "sb-1",
          ...(launch === "exec" ? { execId: "ex-1" } : {}),
        });
      }
      if (stepsStarted) {
        await upsertStep(db, a.scope, {
          attemptId: q.attempt.id,
          stepKey: "0",
          stage: "main",
          index: 0,
          name: "deploy",
          startedAt: T0,
        });
      }
      expect(await markDrainCut(db, a.scope, q.attempt.id, "old")).toBe(true);
      await probe();
      return { q, attempts: await listAttempts(db, a.scope, q.job.id) };
    }
    const notRetried = async (jobId: string) =>
      (await listEvents(db, a.scope, { after: 0, limit: 100 })).filter(
        (e) => e.type === "attempt.drain_cut_not_retried" && e.jobId === jobId,
      );

    for (const klass of ["trusted_pr", "untrusted_pr"]) {
      test(`a ${klass} attempt cut mid-run is requeued once`, async () => {
        const { q, attempts } = await cutJob(klass, true);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.errorClass).toStartWith("controller_lost");
        expect(attempts[1]).toMatchObject({ state: "queued" });
        expect((await getJob(db, a.scope, q.job.id))?.state).toBe("queued");
        expect(await notRetried(q.job.id)).toHaveLength(0);
      });
    }

    test("a protected attempt cut after step 1 is not requeued: infra_error, the reason, an event and an audit entry", async () => {
      const { q, attempts } = await cutJob("protected", true);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ state: "infra_error", errorClass: NOT_RETRIED });
      expect((await getJob(db, a.scope, q.job.id))?.state).toBe("infra_error");
      const ev = await notRetried(q.job.id);
      expect(ev).toHaveLength(1);
      expect(
        typeof ev[0]!.payload === "string" ? JSON.parse(ev[0]!.payload) : ev[0]!.payload,
      ).toMatchObject({
        job_id: q.job.id,
        org_id: a.orgId,
        project_id: a.scope.projectId,
      });
      const audit = await listAudit(db, { orgId: a.orgId }, { limit: 100 });
      expect(audit.some((r) => r.op === "attempt.drain_cut_not_retried")).toBe(true);
    });

    test("a release attempt cut after a step, and one with no recorded class, are not requeued", async () => {
      expect((await cutJob("release", true)).attempts).toHaveLength(1);
      const none = await cutJob(null, true);
      expect(none.attempts).toHaveLength(1);
      expect(none.attempts[0]!.errorClass).toBe(NOT_RETRIED);
    });

    test("a release attempt cut before its first step is requeued", async () => {
      const { q, attempts } = await cutJob("release", false);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({ state: "queued" });
      expect((await getJob(db, a.scope, q.job.id))?.state).toBe("queued");
      expect(await notRetried(q.job.id)).toHaveLength(0);
    });

    test("a protected attempt with an exec and no step rows (the stream lagged) is not requeued", async () => {
      const { q, attempts } = await cutJob("protected", false, "exec");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ state: "infra_error", errorClass: NOT_RETRIED });
      expect(await notRetried(q.job.id)).toHaveLength(1);
      const audit = await listAudit(db, { orgId: a.orgId }, { limit: 100 });
      expect(audit.some((r) => r.op === "attempt.drain_cut_not_retried")).toBe(true);
    });

    test("a sandbox recorded but no exec id yet (exec.start may have run) is not requeued", async () => {
      const { attempts } = await cutJob("release", false, "sandbox");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.errorClass).toBe(NOT_RETRIED);
    });

    test("a protected attempt cut while its sandbox was being created is requeued once", async () => {
      const { q, attempts } = await cutJob("protected", false, "none");
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({ state: "queued" });
      expect(await notRetried(q.job.id)).toHaveLength(0);
    });

    test("a second cut of the same job is not requeued", async () => {
      const { q, attempts } = await cutJob("trusted_pr", true);
      await claim("old2");
      expect(await markDrainCut(db, a.scope, attempts[1]!.id, "old2")).toBe(true);
      await probe();
      const after = await listAttempts(db, a.scope, q.job.id);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ state: "infra_error" });
      expect((await getJob(db, a.scope, q.job.id))?.state).toBe("infra_error");
    });
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

  test("/healthz stays 200 while draining and carries only the draining flag", async () => {
    const plain = await handleRequest(new Request("http://localhost/healthz"));
    expect(await plain.json()).toEqual({
      ok: true,
      version: VERSION,
      build_sha: BUILD_SHA,
      built_at: BUILD_TIME,
    });
    processDrain.trackRunning(() => 3);
    processDrain.set(true, "deploy", T0);
    const res = await handleRequest(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: VERSION,
      build_sha: BUILD_SHA,
      built_at: BUILD_TIME,
      draining: true,
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
    // Instance tokens expire after 30 days from real time: a fixed far-future clock would expire it.
    clock = Date.now();
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
      running_by_mode: { live: 0, shadow: 0 },
      shadow_mode: "wait",
      shadow_cut: 0,
    });
    const status = await asInstance("instance_drain_status");
    expect(status.ok && status.output).toEqual(on.output);
    const off = await asInstance("instance_drain", { on: false, reason: "deploy done" });
    expect(off.ok && off.output).toEqual({
      draining: false,
      running_attempts: 0,
      since: null,
      running_by_mode: { live: 0, shadow: 0 },
      shadow_mode: "wait",
      shadow_cut: 0,
    });
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

describe("drain shadow: cancel (#480)", () => {
  let live: { orgId: string; scope: Required<Scope> };
  beforeEach(async () => {
    const project = await createProject(db, { orgId: a.orgId }, { slug: "gate", name: "gate" });
    live = { orgId: a.orgId, scope: { orgId: a.orgId, projectId: project.id } };
    await setProjectChecksMode(db, live.scope, "live");
    await setProjectChecksMode(db, a.scope, "shadow");
  });

  /** A runner that blocks until its gate opens; an abort ends it as cancelled, like a real stop. */
  function blockingRunner() {
    const gates = new Map<string, ReturnType<typeof gate>>();
    const aborted: string[] = [];
    const starts: string[] = [];
    const runner: AttemptRunner = async (ctx) => {
      const key = `${ctx.job.jobKey}#${ctx.attempt.id}`;
      starts.push(ctx.job.jobKey);
      const g = gate();
      gates.set(ctx.job.jobKey, g);
      ctx.signal.addEventListener("abort", () => {
        aborted.push(ctx.job.jobKey);
        g.open();
      });
      await g.p;
      return ctx.signal.aborted
        ? { state: "cancelled", reason: key }
        : { state: "success", reason: "ok" };
    };
    return { runner, gates, aborted, starts };
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(5);
    expect(cond()).toBe(true);
  };

  test("cancel cuts shadow attempts and leaves live ones running; the cut job is requeued once and runs after the drain", async () => {
    const s = await queueJob(a.scope, "shadow-job");
    const l = await queueJob(live.scope, "live-job");
    const b = blockingRunner();
    const finished: string[] = [];
    const drain = new DrainState();
    const sched = new Scheduler({
      db,
      runner: b.runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
      observer: { started() {}, finished: (c) => finished.push(c.job.jobKey) },
    });
    expect(await sched.tick()).toBe(2);
    drain.set(true, "deploy", T0);
    await drain.applyShadow("cancel");

    expect(drain.shadowMode).toBe("cancel");
    expect(drain.shadowCut).toBe(1);
    await waitFor(() => sched.activeCount === 1);
    expect(b.aborted).toEqual(["shadow-job"]);

    // the shadow job went back to the queue under a new attempt: infra retry, never a failure
    const attempts = await listAttempts(db, a.scope, s.job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "infra_error", leaseOwner: null });
    expect(attempts[0]!.errorClass).toStartWith("controller_lost");
    expect(attempts[1]).toMatchObject({ state: "queued" });
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("queued");
    // the live attempt is untouched and still running
    expect((await listAttempts(db, live.scope, l.job.id))[0]).toMatchObject({ state: "running" });
    expect(await getJob(db, live.scope, l.job.id)).toMatchObject({ state: "running" });
    // no result was reported for the cut attempt
    expect(finished).toEqual([]);

    // a second cancel call finds nothing left to cut
    await drain.applyShadow("cancel");
    expect(drain.shadowCut).toBe(1);

    // draining: the requeued job does not start
    expect(await sched.tick()).toBe(0);
    // after the drain ends (the restart), it runs and succeeds
    drain.set(false, "", T0);
    expect(await sched.tick()).toBe(1);
    b.gates.get("shadow-job")!.open();
    b.gates.get("live-job")!.open();
    await sched.idle();
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("success");
    expect((await getJob(db, live.scope, l.job.id))?.state).toBe("success");
    expect(b.aborted).toEqual(["shadow-job"]);
  });

  test("a project with checks off is cut like shadow", async () => {
    await setProjectChecksMode(db, a.scope, "off");
    const s = await queueJob(a.scope, "off-job");
    const b = blockingRunner();
    const drain = new DrainState();
    const sched = new Scheduler({
      db,
      runner: b.runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
    });
    await sched.tick();
    drain.set(true, "deploy", T0);
    await drain.applyShadow("cancel");
    expect(drain.shadowCut).toBe(1);
    await sched.idle();
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("queued");
  });

  test("a second cut of the same job ends it as infra_error, not another requeue", async () => {
    const s = await queueJob(a.scope, "twice");
    const b = blockingRunner();
    const drain = new DrainState();
    const sched = new Scheduler({
      db,
      runner: b.runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
    });
    await sched.tick();
    drain.set(true, "deploy", T0);
    await drain.applyShadow("cancel");
    await sched.idle();
    drain.set(false, "", T0);
    await sched.tick();
    drain.set(true, "deploy again", T0);
    await drain.applyShadow("cancel");
    await sched.idle();
    expect(await listAttempts(db, a.scope, s.job.id)).toHaveLength(2);
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("infra_error");
  });

  test("wait (the default) cuts nothing and waits for shadow attempts", async () => {
    const s = await queueJob(a.scope, "shadow-job");
    const b = blockingRunner();
    const drain = new DrainState();
    const sched = new Scheduler({
      db,
      runner: b.runner,
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
    });
    await sched.tick();
    drain.set(true, "deploy", T0);
    await drain.applyShadow("wait");
    expect(drain.shadowCut).toBe(0);
    expect(sched.activeCount).toBe(1);
    expect(b.aborted).toEqual([]);
    b.gates.get("shadow-job")!.open();
    await sched.idle();
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("success");
  });

  test("a verdict reached before the stop landed is kept, not requeued", async () => {
    const s = await queueJob(a.scope, "racy");
    const drain = new DrainState();
    const g = gate();
    const sched = new Scheduler({
      db,
      runner: async (ctx) => {
        ctx.signal.addEventListener("abort", () => g.open());
        await g.p;
        return { state: "success", reason: "ok" };
      },
      providers: () => world.provider(),
      globalCap: 50,
      perOrgCap: 50,
      drain,
    });
    await sched.tick();
    drain.set(true, "deploy", T0);
    await drain.applyShadow("cancel");
    await sched.idle();
    expect(await listAttempts(db, a.scope, s.job.id)).toHaveLength(1);
    expect((await getJob(db, a.scope, s.job.id))?.state).toBe("success");
  });

  test("applyShadow does nothing when not draining, and ending the drain resets the count", async () => {
    const d = new DrainState();
    await d.applyShadow("cancel");
    expect(d.shadowMode).toBe("wait");
    d.set(true, "deploy", 1);
    d.trackShadowCutter(async () => 3);
    await d.applyShadow("cancel");
    expect(d.shadowCut).toBe(3);
    d.set(false, "", 2);
    expect(d.shadowCut).toBe(0);
    expect(d.shadowMode).toBe("wait");
  });

  describe("the op", () => {
    let env: DispatchEnv;
    let secret: string;
    beforeEach(async () => {
      env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => Date.now() };
      secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
    });
    const asInstance = (name: string, input: Record<string, unknown> = {}) =>
      dispatch(env, { kind: "bearer", token: secret }, name, input);

    test("status splits running attempts by mode, reports shadow_cut, and the audit records the mode and count", async () => {
      await queueJob(a.scope, "shadow-job");
      await queueJob(live.scope, "live-job");
      await queueJob(live.scope, "live-job-2");
      for (let i = 0; i < 3; i++) {
        await claimNextAttempt(db, {
          owner: "w",
          leaseMs: 60_000,
          now: Date.now(),
          globalCap: 9,
          perOrgCap: 9,
        });
      }
      const status = await asInstance("instance_drain_status");
      expect(status.ok && status.output).toMatchObject({
        running_attempts: 3,
        running_by_mode: { live: 2, shadow: 1 },
        shadow_mode: "wait",
        shadow_cut: 0,
      });

      processDrain.trackShadowCutter(async () => 1);
      const on = await asInstance("instance_drain", {
        on: true,
        reason: "deploy abc123",
        shadow: "cancel",
      });
      expect(on.ok && on.output).toMatchObject({
        draining: true,
        shadow_mode: "cancel",
        shadow_cut: 1,
      });
      const after = await asInstance("instance_drain_status");
      expect(after.ok && after.output).toMatchObject({ shadow_mode: "cancel", shadow_cut: 1 });

      const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
      const row = rows.find((x) => x.op === "instance_drain");
      expect(row).toMatchObject({ effect: "write", outcome: "ok" });
      const input = JSON.parse(row!.input as string) as Record<string, unknown>;
      expect(input).toMatchObject({ shadow: "cancel", shadow_mode: "cancel", shadow_cut: 1 });
    });

    test("a repeat drain call without shadow means wait, never an inherited cancel", async () => {
      const cutter = { n: 0 };
      processDrain.trackShadowCutter(async () => ++cutter.n);
      await asInstance("instance_drain", { on: true, reason: "deploy", shadow: "cancel" });
      expect(cutter.n).toBe(1);
      const again = await asInstance("instance_drain", { on: true, reason: "deploy" });
      expect(again.ok && again.output).toMatchObject({ shadow_mode: "wait", shadow_cut: 1 });
      expect(cutter.n).toBe(1);
      const status = await asInstance("instance_drain_status");
      expect(status.ok && status.output).toMatchObject({ shadow_mode: "wait", shadow_cut: 1 });
    });

    test("shadow defaults to wait and rejects other values; ending the drain resets it", async () => {
      const bad = await asInstance("instance_drain", {
        on: true,
        reason: "deploy",
        shadow: "kill",
      });
      expect(bad.ok).toBe(false);
      const on = await asInstance("instance_drain", { on: true, reason: "deploy" });
      expect(on.ok && on.output).toMatchObject({ shadow_mode: "wait", shadow_cut: 0 });
      await asInstance("instance_drain", { on: true, reason: "deploy", shadow: "cancel" });
      const off = await asInstance("instance_drain", { on: false, reason: "done" });
      expect(off.ok && off.output).toMatchObject({ draining: false, shadow_mode: "wait" });
    });

    test("org tokens are still refused with shadow set, and MCP does not list it", async () => {
      for (const role of ["reader", "operator", "release_operator"] as const) {
        const tok = (await mintToken(db, { orgId: a.orgId }, role)).secret;
        const r = await dispatch(env, { kind: "bearer", token: tok }, "instance_drain", {
          on: true,
          reason: "sneaky",
          shadow: "cancel",
        });
        expect(r.ok, role).toBe(false);
        if (!r.ok) expect(r.error.code, role).toBe("forbidden");
      }
      expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_drain");
      expect(processDrain.draining).toBe(false);
    });
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
