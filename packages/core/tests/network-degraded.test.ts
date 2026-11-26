// A degraded outbound network (#698): two failed probes enter it and two good ones leave it; while
// degraded nothing is claimed, a failure BEFORE any sandbox existed is requeued without using the
// job's one retry, a failure after a sandbox existed is never requeued, and doctor, the admin
// read and MCP show the state. The probe is a fake; the scheduler runs against SQLite.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  claimNextAttempt,
  recordExec,
  setProjectChecksMode,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  listAttempts,
  openDatabase,
  readLog,
  type Scope,
} from "../src/db";
import { systemOrgId } from "../src/audit/failures";
import { listAuditByOp } from "../src/db/repos";
import { checkEgress } from "../src/doctor/checks";
import { NetworkHealth, type ProbeResult, egressProbe, processNetwork } from "../src/network";
import { dispatch, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { type AttemptOutcome, type AttemptRunner, DrainState, Scheduler } from "../src/scheduler";
import type { AttemptObserver } from "../src/scheduler/types";
import { CheckReporter } from "../src/checks/reporter";
import { workflowReadiness } from "../src/scheduler/workflow-readiness";
import { reconcileExpired } from "../src/scheduler";
import { setupChecksWorld } from "./checks-helpers";
import { mintToken, seedWorld } from "./ops-helpers";

setDefaultTimeout(30_000);

const world = new FakeWorld();
const opened: Db[] = [];
afterAll(() => {
  world.dispose();
  for (const d of opened) d.close();
});

const bad: ProbeResult = {
  ok: false,
  targets: [{ target: "forge", ok: false, error: "ENOTFOUND" }],
};
const good: ProbeResult = { ok: true, targets: [{ target: "forge", ok: true, httpMs: 12 }] };

/** A health whose fake probe answers from a script, with a clock the test moves. */
function fakeHealth() {
  const clock = { t: 1_000_000 };
  let next: ProbeResult = good;
  const changes: string[] = [];
  const net = new NetworkHealth({
    probe: async () => next,
    now: () => clock.t,
    onChange: (s) => changes.push(s),
  });
  return {
    net,
    clock,
    changes,
    answer: (r: ProbeResult) => (next = r),
    probe: async (r: ProbeResult) => {
      next = r;
      clock.t += 15_000;
      await net.probeNow();
    },
  };
}

describe("probe state machine", () => {
  test("two failures enter degraded, two successes leave it", async () => {
    const h = fakeHealth();
    await h.probe(bad);
    expect(h.net.degraded).toBe(false);
    expect(h.net.suspect).toBe(true);
    await h.probe(bad);
    expect(h.net.degraded).toBe(true);
    await h.probe(good);
    expect(h.net.degraded).toBe(true); // one success is not enough
    await h.probe(bad); // a failure resets the success streak
    await h.probe(good);
    expect(h.net.degraded).toBe(true);
    await h.probe(good);
    expect(h.net.degraded).toBe(false);
    expect(h.changes).toEqual(["degraded", "healthy"]);
    const snap = h.net.snapshot();
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]!.end).not.toBeNull();
  });

  test("the state is unknown until a probe has run", async () => {
    const h = fakeHealth();
    expect(h.net.snapshot().state).toBe("unknown");
    await h.probe(good);
    expect(h.net.snapshot().state).toBe("healthy");
  });

  test("a single failure between successes never degrades", async () => {
    const h = fakeHealth();
    await h.probe(bad);
    await h.probe(good);
    await h.probe(bad);
    expect(h.net.degraded).toBe(false);
    expect(h.changes).toEqual([]);
  });

  test("a probe that throws counts as a failure", async () => {
    const net = new NetworkHealth({
      probe: async () => {
        throw new Error("boom");
      },
    });
    await net.probeNow();
    await net.probeNow();
    expect(net.degraded).toBe(true);
    expect(JSON.stringify(net.snapshot())).not.toContain("boom");
  });

  test("the real probe fails only when every target failed, and reports codes not URLs", async () => {
    const urls: string[] = [];
    const probe = egressProbe({
      targets: [
        { label: "forge", url: "https://forge.example/" },
        { label: "other", url: "https://other.example/" },
      ],
      lookup: async (host) => {
        if (host === "forge.example") throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      },
      fetch: (async (u: string) => {
        urls.push(String(u));
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch,
    });
    const r = await probe();
    expect(r.ok).toBe(true); // reachable even with a 401
    expect(r.targets.find((t) => t.target === "forge")?.error).toBe("ENOTFOUND");
    expect(JSON.stringify(r)).not.toContain("example");
    const none = egressProbe({
      targets: [{ label: "forge", url: "https://forge.example/" }],
      lookup: async () => {
        throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      },
    });
    expect((await none()).ok).toBe(false);
  });

  test("waitHealthy resolves at recovery or after its cap", async () => {
    const h = fakeHealth();
    await h.probe(bad);
    await h.probe(bad);
    let done = false;
    const w = h.net.waitHealthy(60_000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await h.probe(good);
    await h.probe(good);
    await w;
    expect(done).toBe(true);
    await h.probe(bad);
    await h.probe(bad);
    await h.net.waitHealthy(5); // the cap
  });
});

async function setup() {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "org-a", name: "org-a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const scope: Required<Scope> = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const mk = async (key: string) => {
    const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
    const first = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
    return { job, first };
  };
  const finished: { attemptId: string; state: string }[] = [];
  const observer: AttemptObserver = {
    started: () => {},
    finished: (c, o) => finished.push({ attemptId: c.attempt.id, state: o.state }),
  };
  const h = fakeHealth();
  const sched = (runner: AttemptRunner) =>
    new Scheduler({
      db,
      runner,
      providers: () => world.provider(),
      globalCap: 5,
      perOrgCap: 5,
      drain: new DrainState(),
      network: h.net,
      observer,
      infraRetryBackoffMs: 0,
    });
  const drive = async (s: Scheduler): Promise<number> => {
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const n = await s.tick();
      await s.idle();
      total += n;
      if (n === 0) break;
    }
    return total;
  };
  return { db, scope, mk, finished, h, sched, drive };
}

/** A runner that records a sandbox first when `withSandbox`, then returns the next scripted outcome. */
const scripted = (outcomes: AttemptOutcome[], withSandbox: boolean, seen: string[] = []) => {
  let n = 0;
  const runner: AttemptRunner = async (ctx) => {
    seen.push(ctx.attempt.id);
    await ctx.store.setTrustClass("trusted_pr").catch(() => undefined);
    if (withSandbox) await ctx.store.setExec({ sandboxId: `sb-${n}` });
    return outcomes[Math.min(n++, outcomes.length - 1)]!;
  };
  return runner;
};

const createFailed: AttemptOutcome = {
  state: "infra_error",
  infraKind: "sandbox_create_failed",
  reason: "provider create timed out",
};
const ok: AttemptOutcome = { state: "success", reason: "" };

describe("scheduler while the network is degraded", () => {
  test("nothing is claimed while degraded; the queue resumes after recovery", async () => {
    const t = await setup();
    const seen: string[] = [];
    const s = t.sched(scripted([ok], false, seen));
    await t.mk("a");
    await t.h.probe(bad);
    await t.h.probe(bad);
    expect(await s.tick()).toBe(0);
    expect(seen).toEqual([]);
    await t.h.probe(good);
    await t.h.probe(good);
    expect(await t.drive(s)).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("a pre-sandbox failure during degraded is requeued, keeps its retry, and ends with the real result", async () => {
    const t = await setup();
    const { job, first } = await t.mk("build");
    const seen: string[] = [];
    const outcomes: AttemptOutcome[] = [
      createFailed,
      { state: "infra_error", infraKind: "sandbox_lost", reason: "lost" },
      ok,
    ];
    let n = 0;
    const notices: (readonly string[])[] = [];
    const runner: AttemptRunner = async (ctx) => {
      seen.push(ctx.attempt.id);
      notices.push(ctx.notices ?? []);
      await ctx.store.setTrustClass("trusted_pr").catch(() => undefined);
      // The first attempt was claimed just before the outage and fails inside it.
      if (n === 0) {
        await t.h.probe(bad);
        await t.h.probe(bad);
        t.h.answer(bad);
      }
      return outcomes[Math.min(n++, outcomes.length - 1)]!;
    };
    const s = t.sched(runner);
    expect(await s.tick()).toBe(1);
    await s.idle();
    expect(t.h.net.degraded).toBe(true);

    const afterFail = await listAttempts(t.db, t.scope, job.id);
    expect(afterFail).toHaveLength(2);
    expect(afterFail[0]!.id).toBe(first.id);
    expect(afterFail[0]!.state).toBe("infra_error");
    expect(afterFail[0]!.errorClass).toStartWith("network_degraded");
    expect(afterFail[0]!.infraKind).toBeNull(); // does not count as the job's retry
    expect(afterFail[1]!.state).toBe("queued");
    expect(afterFail[1]!.id.slice(0, 10)).toBe(first.id.slice(0, 10)); // keeps its place in line
    expect((await getJob(t.db, t.scope, job.id))?.state).toBe("queued");
    expect(t.finished).toEqual([]); // no infra_error check was reported
    expect(await s.tick()).toBe(0); // and nothing is claimed meanwhile

    // Recovery: the requeued attempt runs; its later transient failure still gets the one retry.
    await t.h.probe(good);
    await t.h.probe(good);
    await t.drive(s);
    const all = await listAttempts(t.db, t.scope, job.id);
    expect(all.map((a) => a.state)).toEqual(["infra_error", "infra_error", "success"]);
    expect(all[1]!.infraKind).toBe("sandbox_lost"); // the retry was still available
    expect((await getJob(t.db, t.scope, job.id))?.state).toBe("success");
    expect(t.finished.map((f) => f.state)).toEqual(["success"]);
    const text = (id: string) =>
      readLog(t.db, t.scope, id).then((cs) =>
        cs.map((c) => new TextDecoder().decode(c.bytes)).join(""),
      );
    expect(await text(all[0]!.id)).toContain("network degraded");
    // The attempt that waited out the window gets one line for it in its job log (the runner
    // writes ctx.notices at the top of the log); the later retry does not repeat it.
    expect(notices[0]).toEqual([]);
    expect(notices[1]).toHaveLength(1);
    expect(notices[1]![0]).toContain("waited out a network degraded window");
    expect(notices[2]).toEqual([]);
  });

  test("a checkout fetch failure (full history or submodules) during degraded is requeued", async () => {
    const t = await setup();
    const { job } = await t.mk("build");
    const runner: AttemptRunner = async (ctx) => {
      await ctx.store.setTrustClass("trusted_pr").catch(() => undefined);
      await t.h.probe(bad);
      await t.h.probe(bad);
      t.h.answer(bad);
      return {
        state: "infra_error",
        infraKind: "checkout_fetch_failed",
        reason: "checkout: fetch failed",
      };
    };
    const s = t.sched(runner);
    expect(await s.tick()).toBe(1);
    await s.idle();
    const all = await listAttempts(t.db, t.scope, job.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.errorClass).toStartWith("network_degraded");
    expect(all[0]!.infraKind).toBeNull();
    expect(all[1]!.state).toBe("queued");
    expect(t.finished).toEqual([]);
  });

  test("a failure after a sandbox existed is not requeued for the network", async () => {
    const t = await setup();
    const { job } = await t.mk("deploy");
    const runner: AttemptRunner = async (ctx) => {
      await ctx.store.setTrustClass("protected").catch(() => undefined);
      await ctx.store.setExec({ sandboxId: "sb-1" }); // the sandbox existed: side effects possible
      await t.h.probe(bad);
      await t.h.probe(bad);
      return { state: "infra_error", infraKind: "unknown", reason: "connection reset" };
    };
    const s = t.sched(runner);
    expect(await s.tick()).toBe(1);
    await s.idle();
    expect(t.h.net.degraded).toBe(true);
    const all = await listAttempts(t.db, t.scope, job.id);
    expect(all).toHaveLength(1); // not requeued, and a protected job gets no mid-run retry
    expect(all[0]!.state).toBe("infra_error");
    expect(all[0]!.errorClass ?? "").not.toStartWith("network_degraded");
    expect((await getJob(t.db, t.scope, job.id))?.state).toBe("infra_error");
    expect(t.finished.map((f) => f.state)).toEqual(["infra_error"]);
  });

  test("a pull request job that had a sandbox keeps today's one retry, not a network requeue", async () => {
    const t = await setup();
    const { job } = await t.mk("test");
    let n = 0;
    const runner: AttemptRunner = async (ctx) => {
      await ctx.store.setTrustClass("trusted_pr").catch(() => undefined);
      if (n++ > 0) return ok;
      await ctx.store.setExec({ sandboxId: "sb-1" });
      await t.h.probe(bad);
      await t.h.probe(bad);
      return { state: "infra_error", infraKind: "unknown", reason: "connection reset" };
    };
    const s = t.sched(runner);
    await s.tick();
    await s.idle();
    const all = await listAttempts(t.db, t.scope, job.id);
    expect(all[0]!.infraKind).toBe("unknown"); // the infra retry path, with its kind
    expect(all[0]!.errorClass ?? "").not.toStartWith("network_degraded");
  });
});

describe("doctor, admin read and MCP", () => {
  test("doctor warns while degraded and lists the window after recovery", async () => {
    const h = fakeHealth();
    expect(checkEgress(h.net).status).toBe("pass");
    await h.probe(bad);
    await h.probe(bad);
    const d = checkEgress(h.net);
    expect(d.status).toBe("warn");
    expect(d.summary).toContain("degraded");
    expect(d.summary).toContain("still open");
    await h.probe(good);
    await h.probe(good);
    const r = checkEgress(h.net);
    expect(r.status).toBe("pass");
    expect(r.summary).toContain("1 degraded window");
  });

  test("network_status is an MCP tool for a reader; the instance read adds probe detail", async () => {
    const { db, a } = await seedWorld();
    processNetwork.reset();
    processNetwork.record(bad);
    processNetwork.record(bad);
    try {
      const names = mcpTools(registry).map((x) => x.name);
      expect(names).toContain("network_status");
      expect(names).not.toContain("instance_network_status");
      const reader = await mintToken(db, { orgId: a.orgId }, "reader");
      const env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
      const r = await dispatch(env, { kind: "bearer", token: reader.secret }, "network_status", {});
      expect(r.ok).toBe(true);
      const out = (r as { output: { state: string; windows: { end: string | null }[] } }).output;
      expect(out.state).toBe("degraded");
      expect(out.windows).toHaveLength(1);
      expect(out.windows[0]!.end).toBeNull();
      expect(JSON.stringify(out)).not.toContain("ENOTFOUND");

      const inst = await createInstanceTokenFromCli(db, { name: "ops" });
      const i = await dispatch(
        env,
        { kind: "bearer", token: inst.secret },
        "instance_network_status",
        {},
      );
      expect(i.ok).toBe(true);
      const io = (
        i as {
          output: {
            state: string;
            consecutive_failures: number;
            targets: { error: string | null }[];
          };
        }
      ).output;
      expect(io.state).toBe("degraded");
      expect(io.consecutive_failures).toBe(2);
      expect(io.targets[0]!.error).toBe("ENOTFOUND");
      // The banner polls this read: it writes no audit row (state changes are audited elsewhere).
      const sys = { orgId: await systemOrgId(db) };
      const rows = () =>
        listAuditByOp(db, sys, { op: "instance_network_status", outcome: "ok", limit: 10 });
      for (let k = 0; k < 3; k++)
        await dispatch(env, { kind: "bearer", token: inst.secret }, "instance_network_status", {});
      expect(await rows()).toHaveLength(0);
      // An org token cannot read the instance variant.
      const denied = await dispatch(
        env,
        { kind: "bearer", token: reader.secret },
        "instance_network_status",
        {},
      );
      expect(denied.ok).toBe(false);
    } finally {
      processNetwork.reset();
    }
  });
});

describe("reporter and reconcile", () => {
  test("check posts wait while degraded and go out after recovery", async () => {
    const w = await setupChecksWorld();
    await setProjectChecksMode(w.db, w.scope, "live");
    const c = await w.claim();
    const h = fakeHealth();
    await h.probe(bad);
    await h.probe(bad);
    const posted: string[] = [];
    const rep = new CheckReporter({
      db: w.db,
      auth: { mint: async () => ({ token: "stub" }) },
      api: {
        create: async (_t, _r, body) => {
          posted.push(String(body.status));
          return "1";
        },
        update: async () => {},
        findByExternalId: async () => undefined,
      },
      sleep: async () => {},
      network: h.net,
    });
    rep.started(c);
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toEqual([]); // held while degraded
    await h.probe(good);
    await h.probe(good);
    await rep.idle();
    expect(posted).toEqual(["in_progress"]);
    w.db.close();
  });

  test("a lost controller with no sandbox is requeued while degraded; one with a sandbox is not", async () => {
    for (const withSandbox of [false, true]) {
      const t = await setup();
      const { job } = await t.mk("build");
      const claim = await claimNextAttempt(t.db, {
        owner: "dead-worker",
        leaseMs: 1000,
        now: 5_000,
        globalCap: 5,
        perOrgCap: 5,
        quotaCacheMs: 0,
        readiness: workflowReadiness,
        preemptLimit: { max: 3, windowMs: 60_000 },
      });
      expect(claim).toBeDefined();
      if (withSandbox) {
        await recordExec(t.db, t.scope, claim!.attempt.id, "dead-worker", { sandboxId: "sb-9" });
      }
      await t.h.probe(bad);
      await t.h.probe(bad);
      await reconcileExpired(t.db, () => world.provider(), {
        now: () => 60_000,
        network: t.h.net,
      });
      const all = await listAttempts(t.db, t.scope, job.id);
      if (withSandbox) {
        expect(all).toHaveLength(1);
        expect(all[0]!.errorClass ?? "").not.toStartWith("network_degraded");
        expect((await getJob(t.db, t.scope, job.id))?.state).toBe("infra_error");
      } else {
        expect(all).toHaveLength(2);
        expect(all[0]!.errorClass).toStartWith("network_degraded");
        expect(all[1]!.state).toBe("queued");
        expect((await getJob(t.db, t.scope, job.id))?.state).toBe("queued");
      }
    }
  });
});
