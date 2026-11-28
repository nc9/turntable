// Drain shadow mode cut_branches (#784): branch attempts are cut, default-branch push attempts are
// requeued with no rerun used, and both carry the drain label.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  drainCutLabel,
  getJob,
  listAttempts,
  openDatabase,
  recordTrustClass,
  type Scope,
  setProjectChecksMode,
  setProjectIngest,
  updateAttempt,
  upsertStep,
} from "../src/db";
import { DrainState, Scheduler, type AttemptRunner } from "../src/scheduler";

let db: Db;
let scope: Required<Scope>;
let world: FakeWorld;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "org-a", name: "org-a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  scope = { orgId: org.id, projectId: project.id };
  await setProjectChecksMode(db, scope, "shadow");
  await setProjectIngest(db, scope, JSON.stringify({ defaultBranch: "main" }));
  world = new FakeWorld();
});
afterEach(() => world.dispose());

async function queue(key: string, event: string, ref: string) {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event,
    ref,
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
  await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
  return job;
}

function setup() {
  const aborted: string[] = [];
  const gates: (() => void)[] = [];
  const runner: AttemptRunner = async (ctx) => {
    await new Promise<void>((open) => {
      gates.push(open);
      ctx.signal.addEventListener("abort", () => {
        aborted.push(ctx.job.jobKey);
        open();
      });
    });
    return ctx.signal.aborted
      ? { state: "cancelled", reason: "stopped" }
      : { state: "success", reason: "ok" };
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
  return { sched, drain, aborted, gates };
}

describe("drain shadow: cut_branches (#784)", () => {
  test("cuts branch and PR attempts, requeues default-branch push attempts, with the drain label", async () => {
    const branch = await queue("branch", "push", "refs/heads/feature");
    const pr = await queue("pr", "pull_request", "refs/pull/3/head");
    const main = await queue("main", "push", "refs/heads/main");
    const s = setup();
    expect(await s.sched.tick()).toBe(3);
    s.drain.set(true, "deploy", T0);
    await s.drain.applyShadow("cut_branches");
    await s.sched.idle();
    expect(s.drain.shadowCut).toBe(3);

    for (const j of [branch, pr]) {
      expect((await getJob(db, scope, j.id))?.state).toBe("cancelled");
      const [a] = await listAttempts(db, scope, j.id);
      expect(a).toMatchObject({ state: "cancelled", errorClass: "drain_cut" });
      expect(drainCutLabel(a!.errorClass)).toBe("cancelled by deploy drain");
    }
    // the default-branch push is requeued under a new attempt: queued, not cancelled
    expect((await getJob(db, scope, main.id))?.state).toBe("queued");
    const attempts = await listAttempts(db, scope, main.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "infra_error", errorClass: "drain_cut" });
    expect(drainCutLabel(attempts[0]!.errorClass)).toBe("cancelled by deploy drain");
    expect(attempts[1]).toMatchObject({ state: "queued" });
    // no rerun reason: it used none of the commit's reruns
    expect(attempts[1]!.rerunReason ?? null).toBeNull();

    // after the restart it runs again by itself
    s.drain.set(false, "", T0);
    expect(await s.sched.tick()).toBe(1);
    s.gates.at(-1)!();
    await s.sched.idle();
    expect((await getJob(db, scope, main.id))?.state).toBe("success");
  });

  test("a default-branch push attempt is requeued by every drain, not once", async () => {
    const main = await queue("main", "push", "refs/heads/main");
    const s = setup();
    for (let i = 0; i < 3; i++) {
      await s.sched.tick();
      s.drain.set(true, "deploy", T0);
      await s.drain.applyShadow("cut_branches");
      await s.sched.idle();
      s.drain.set(false, "", T0);
      expect((await getJob(db, scope, main.id))?.state).toBe("queued");
    }
    expect(await listAttempts(db, scope, main.id)).toHaveLength(4);
  });

  test("a default-branch push attempt with steps started is waited for, never cut or requeued", async () => {
    const main = await queue("main", "push", "refs/heads/main");
    const branch = await queue("branch", "push", "refs/heads/feature");
    const s = setup();
    expect(await s.sched.tick()).toBe(2);
    const [att] = await listAttempts(db, scope, main.id);
    await upsertStep(db, scope, {
      attemptId: att!.id,
      stepKey: "s1",
      stage: "main",
      index: 0,
      name: "deploy",
      startedAt: T0,
    });
    s.drain.set(true, "deploy", T0);
    await s.drain.applyShadow("cut_branches");
    // only the branch attempt was cut; the main push is still running and counts in the wait
    expect(s.drain.shadowCut).toBe(1);
    for (let i = 0; i < 100 && (await getJob(db, scope, branch.id))?.state !== "cancelled"; i++) {
      await Bun.sleep(10);
    }
    expect(s.aborted).toEqual(["branch"]);
    expect((await getJob(db, scope, branch.id))?.state).toBe("cancelled");
    expect((await getJob(db, scope, main.id))?.state).toBe("running");
    const attempts = await listAttempts(db, scope, main.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("running");
    s.gates[0]!();
    await s.sched.idle();
    expect((await getJob(db, scope, main.id))?.state).toBe("success");
  });

  test("a default-branch push attempt with only a sandbox recorded is waited for (no trust class, protected)", async () => {
    for (const trustClass of [undefined, "protected"]) {
      const main = await queue(`main-${trustClass ?? "none"}`, "push", "refs/heads/main");
      const s = setup();
      expect(await s.sched.tick()).toBe(1);
      const [att] = await listAttempts(db, scope, main.id);
      await updateAttempt(db, scope, att!.id, { sandboxId: "sb-1" });
      if (trustClass) {
        expect(await recordTrustClass(db, scope, att!.id, att!.leaseOwner!, trustClass)).toBe(true);
      }
      s.drain.set(true, "deploy", T0);
      await s.drain.applyShadow("cut_branches");
      expect(s.drain.shadowCut).toBe(0);
      expect((await getJob(db, scope, main.id))?.state).toBe("running");
      expect(await listAttempts(db, scope, main.id)).toHaveLength(1);
      s.gates[0]!();
      await s.sched.idle();
      expect((await getJob(db, scope, main.id))?.state).toBe("success");
    }
  });

  test("a default-branch push cut while its sandbox is being created is requeued, not infra_error", async () => {
    for (const trustClass of [undefined, "protected"]) {
      const main = await queue(`main-${trustClass ?? "none"}`, "push", "refs/heads/main");
      // The runner records its sandbox only once the stop has landed, as job-exec does when
      // `provider.create` returns after the cut.
      const runner: AttemptRunner = async (ctx) => {
        await new Promise<void>((open) => ctx.signal.addEventListener("abort", () => open()));
        await updateAttempt(db, scope, ctx.attempt.id, { sandboxId: "sb-late" });
        return { state: "cancelled", reason: "stopped" };
      };
      const drain = new DrainState();
      const sched = new Scheduler({
        db,
        runner,
        providers: () => world.provider(),
        globalCap: 50,
        perOrgCap: 50,
        drain,
        onlyRun: main.runId,
      });
      expect(await sched.tick()).toBe(1);
      const [att] = await listAttempts(db, scope, main.id);
      if (trustClass) {
        expect(await recordTrustClass(db, scope, att!.id, att!.leaseOwner!, trustClass)).toBe(true);
      }
      drain.set(true, "deploy", T0);
      await drain.applyShadow("cut_branches");
      await sched.idle();
      expect((await getJob(db, scope, main.id))?.state).toBe("queued");
      const attempts = await listAttempts(db, scope, main.id);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ state: "infra_error", errorClass: "drain_cut" });
      expect(attempts[1]).toMatchObject({ state: "queued" });
    }
  });

  test("a user or API cancellation has no drain label", () => {
    expect(drainCutLabel(null)).toBeNull();
    expect(drainCutLabel("incident_freeze")).toBeNull();
    expect(drainCutLabel("controller_lost (drain cancel)")).toBe("cancelled by deploy drain");
  });
});
