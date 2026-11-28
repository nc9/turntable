// A resumed attempt that ends before it re-attaches releases the sandbox it inherited (#512): the
// exec is stopped and the sandbox destroyed through the provider, the job log and the audit chain
// name it. A normal resume and a fresh attempt are unchanged. Runs on both dialects.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import {
  bindRepo,
  createAttempt,
  createJob,
  createRun,
  type Db,
  appendLog,
  getAttempt,
  listAudit,
  openDatabase,
} from "../src/db";
import { openPostgres } from "../src/db/pg";
import { dispatch, registry, type Credential } from "../src/ops";
import { createActRunner } from "../src/scheduler";
import type { AttemptContext, AttemptStore } from "../src/scheduler";
import { parseSandboxSizes, setOperatorSizes } from "../src/scheduler/sandbox-size";
import { ambientSettings } from "../src/settings/ambient";
import { mintToken, seedTenant, type Tenant } from "./ops-helpers";

const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures");
const WORKFLOW =
  "name: t\non: push\njobs:\n  hello:\n    runs-on: my-box\n    steps:\n      - run: echo hi\n";

const gated = (orgs?: string[]) =>
  parseSandboxSizes(
    JSON.stringify({
      classes: {
        small: { cpus: 2 },
        mac: { cpus: 4, tenantSelectable: false, ...(orgs ? { orgs } : {}) },
      },
      default: "small",
    }),
    "test",
  );

const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres({ pglite: true }, { fresh: true })],
];

describe.each(dialects)("resumed attempt (%s)", (_name, open) => {
  let world: FakeWorld;
  let provider: Provider;
  let db: Db;
  let a: Tenant;

  beforeEach(async () => {
    world = new FakeWorld();
    provider = world.provider();
    db = open();
    a = await seedTenant(db, "org-a");
    await bindRepo(db, a.scope, { forge: "github", owner: "acme", repo: "web" });
  });
  afterEach(() => {
    db.close();
    world.dispose();
    setOperatorSizes(undefined);
  });

  /** A stored tenant map `my-box -> mac`, then an operator config where the org may no longer pick `mac`. */
  async function staleTenantEntry() {
    setOperatorSizes(gated([a.slug]));
    const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
    const res = await dispatch(
      { registry, db, settings: ambientSettings() },
      { kind: "bearer", token: secret } as Credential,
      "set_setting",
      { key: "runner_labels", value: { "my-box": "mac" } },
    );
    expect(res.ok).toBe(true);
    return gated();
  }

  async function claimed() {
    const run = await createRun(db, a.scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "a".repeat(40),
    });
    const job = (await createJob(db, a.scope, {
      runId: run.id,
      jobKey: "hello",
      name: "hello",
      planned: {
        key: "hello",
        id: "hello",
        name: "hello",
        needs: [],
        needsIds: [],
        continueOnError: false,
        outputs: {},
        failFast: true,
        runsOn: ["my-box"],
      },
    }))!;
    const attempt = (await createAttempt(db, a.scope, { jobId: job.id, provider: "fake" }))!;
    return { run, job, attempt };
  }

  async function sandboxWithExec(tail = "sleep 5") {
    const sb = await provider.create({
      name: "job",
      labels: {},
      ttlSeconds: 600,
      network: { egress: "none" },
    });
    const { execId } = await provider.exec.start(sb.id, {
      argv: ["sh", "-c", `cat '${join(FIXTURE, "success.jsonl")}'; ${tail}`],
      timeoutSeconds: 30,
    });
    return { sandboxId: sb.id, execId };
  }

  function setup(opts: { resume?: { sandboxId: string; execId: string }; signal?: AbortSignal }) {
    return async () => {
      const q = await claimed();
      const logs: string[] = [];
      let resets = 0;
      const stored: { offset: number; bytes: Uint8Array }[] = [];
      let destroyedAt: number | undefined;
      const store = {
        setExec: async (w: { sandboxDestroyedAt?: number }) =>
          void (destroyedAt = w.sandboxDestroyedAt),
        setPlan: async () => {},
        setTrustClass: async () => {},
        reset: async () => {
          resets++;
          logs.length = 0;
          stored.length = 0;
        },
        appendLog: async (offset: number, bytes: Uint8Array) => {
          logs.push(`${offset}:${new TextDecoder().decode(bytes)}`);
          stored.push({ offset, bytes });
        },
        recordStep: async () => {},
        addCut: async () => {},
      } as AttemptStore;
      const ctx: AttemptContext = {
        attempt: { ...(await getAttempt(db, a.scope, q.attempt.id))!, trustClass: "protected" },
        job: q.job,
        run: q.run,
        scope: a.scope,
        provider,
        signal: opts.signal ?? new AbortController().signal,
        store,
        ...(opts.resume ? { resume: opts.resume } : {}),
      };
      return { ctx, logs, stored, resets: () => resets, destroyedAt: () => destroyedAt };
    };
  }

  const source = (checkout?: () => never) => ({
    checkout:
      checkout ??
      (async () => ({
        tarball: new Uint8Array(),
        readFile: (p: string) => (p === "w.yml" ? WORKFLOW : undefined),
      })),
  });

  const auditOps = async () =>
    (await listAudit(db, a.scope, { limit: 50 })).filter((r) => r.op === "sandbox.release_resumed");

  test("a stale tenant class entry on resume: the inherited sandbox is deleted and named", async () => {
    const sizes = await staleTenantEntry();
    const r = await setup({ resume: await sandboxWithExec() })();
    expect(await provider.list({})).toHaveLength(1);
    const out = await createActRunner({ db, source: source(), sizes, pollMs: 25 })(r.ctx);
    expect(out).toMatchObject({ state: "failure" });
    expect(out.reason).toContain("which this org may not select");
    expect(await provider.list({})).toEqual([]);
    const id = r.ctx.resume!.sandboxId;
    expect(r.logs.join("")).toContain(`released sandbox ${id}`);
    expect(r.logs.some((l) => l.startsWith("0:unsupported"))).toBe(true); // the refusal line is first
    expect(r.destroyedAt()).toBeGreaterThan(0);
    const audit = await auditOps();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input).toContain(id);
    expect(audit[0]!.input).toContain("ended before re-attaching");
  });

  test("an error before re-attach: the sandbox is deleted, the error still surfaces", async () => {
    const r = await setup({ resume: await sandboxWithExec() })();
    const boom = (): never => {
      throw new Error("checkout exploded");
    };
    await expect(createActRunner({ db, source: source(boom), pollMs: 25 })(r.ctx)).rejects.toThrow(
      "checkout exploded",
    );
    expect(await provider.list({})).toEqual([]);
    expect(r.logs.join("")).toContain(`released sandbox ${r.ctx.resume!.sandboxId}`);
    const audit = await auditOps();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input).toContain("checkout exploded");
  });

  test("a cancel before re-attach: the sandbox is deleted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await setup({ resume: await sandboxWithExec(), signal: ac.signal })();
    const out = await createActRunner({ db, source: source(), pollMs: 25 })(r.ctx);
    expect(out.state).toBe("cancelled");
    expect(await provider.list({})).toEqual([]);
    expect(r.logs.join("")).toContain(`released sandbox ${r.ctx.resume!.sandboxId}`);
    const audit = await auditOps();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input).toContain("cancelled before re-attaching");
  });

  test("a wrapper's refusal to resume (refuseResume): the exec is stopped, the sandbox destroyed, the job not run", async () => {
    const r = await setup({ resume: await sandboxWithExec() })();
    const reason = "re-attached attempt lost its secrets-proxy credential (test); not resumed";
    const out = await createActRunner({ db, source: source(), pollMs: 25 })({
      ...r.ctx,
      refuseResume: reason,
    });
    expect(out).toEqual({ state: "infra_error", reason });
    expect(await provider.list({})).toEqual([]);
    expect(r.destroyedAt()).toBeGreaterThan(0);
    expect(r.logs.join("")).toContain(`released sandbox ${r.ctx.resume!.sandboxId}`);
    expect(r.logs.join("")).not.toContain("hi");
    const audit = await auditOps();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input).toContain("lost its secrets-proxy credential");
  });

  test("a failed destroy is logged and audited as such, and not recorded as destroyed", async () => {
    const sizes = await staleTenantEntry();
    const r = await setup({ resume: await sandboxWithExec() })();
    world.failNext("destroy");
    await createActRunner({ db, source: source(), sizes, pollMs: 25 })(r.ctx);
    expect(r.logs.join("")).toContain("could not release sandbox");
    expect(r.destroyedAt()).toBeUndefined();
    expect((await auditOps())[0]!.outcome).toBe("error");
  });

  test("a normal resume still re-attaches and finishes, destroying its sandbox once, with no release line", async () => {
    const r = await setup({ resume: await sandboxWithExec("true") })();
    const out = await createActRunner({ db, source: source(), pollMs: 25 })(r.ctx);
    expect(out.state).toBe("success");
    expect(await provider.list({})).toEqual([]);
    expect(r.logs.join("")).not.toContain("released sandbox");
    expect(await auditOps()).toEqual([]);
  });

  test("a fresh attempt's refusal creates no sandbox and releases nothing", async () => {
    const sizes = await staleTenantEntry();
    const r = await setup({})();
    const out = await createActRunner({ db, source: source(), sizes, pollMs: 25 })(r.ctx);
    expect(out.state).toBe("failure");
    expect(await provider.list({})).toEqual([]);
    expect(r.resets()).toBe(0);
    expect(r.logs.join("")).not.toContain("released sandbox");
    expect(await auditOps()).toEqual([]);
  });

  test("an early exit keeps the dead worker's partial log and appends the reason and release lines (#516)", async () => {
    const sizes = await staleTenantEntry();
    const r = await setup({ resume: await sandboxWithExec() })();
    const partial = "step one ran\nstep two ran\n";
    const bytes = new TextEncoder().encode(partial);
    // the dead worker's output, stored before the restart
    await appendLog(db, a.scope, r.ctx.attempt.id, 0, bytes);
    const out = await createActRunner({ db, source: source(), sizes, pollMs: 25 })(r.ctx);
    expect(out.state).toBe("failure");
    expect(r.resets()).toBe(0);
    // appended after the partial log: the first early-exit line lands at its end, the release line follows
    const len = bytes.length;
    expect(r.logs[0]!.startsWith(`${len}:unsupported:`)).toBe(true);
    const refusal = r.stored[0]!;
    expect(r.stored[1]!.offset).toBe(len + refusal.bytes.length);
    expect(r.logs[1]).toContain(`released sandbox ${r.ctx.resume!.sandboxId}`);
    expect(r.logs).toHaveLength(2);
  });

  test("a resumed attempt that re-attaches resets once and replays the exec log with no duplicates (#516)", async () => {
    const r = await setup({ resume: await sandboxWithExec("true") })();
    await appendLog(db, a.scope, r.ctx.attempt.id, 0, new TextEncoder().encode("old partial\n"));
    const out = await createActRunner({ db, source: source(), pollMs: 25 })(r.ctx);
    expect(out.state).toBe("success");
    expect(r.resets()).toBe(1);
    const text = r.logs.map((l) => l.slice(l.indexOf(":") + 1)).join("");
    expect(text).not.toContain("old partial");
    expect(text).not.toContain("released sandbox");
    // offsets are contiguous: nothing written twice
    let end = 0;
    for (const c of r.stored) {
      expect(c.offset).toBe(end);
      end += c.bytes.length;
    }
  });
});
