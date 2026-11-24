// A resumed attempt that ends before it re-attaches releases the sandbox it inherited (#512): the
// exec is stopped and the sandbox destroyed through the provider, the job log and the audit chain
// name it. A normal resume and a fresh attempt are unchanged. Runs on both dialects.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import {
  bindRepo,
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttempt,
  listAudit,
} from "../src/db";
import { dispatch, registry, type Credential } from "../src/ops";
import { createActRunner } from "../src/scheduler";
import type { AttemptContext, AttemptStore } from "../src/scheduler";
import { parseSandboxSizes, setOperatorSizes } from "../src/scheduler/sandbox-size";
import { ambientSettings } from "../src/settings/ambient";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

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

let world: FakeWorld;
let provider: Provider;
let db: Db;
let a: Tenant;

beforeEach(async () => {
  world = new FakeWorld();
  provider = world.provider();
  ({ db, a } = await seedWorld());
  await bindRepo(db, a.scope, { forge: "github", owner: "acme", repo: "web" });
});
afterEach(() => {
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
    let destroyedAt: number | undefined;
    const store = {
      setExec: async (w: { sandboxDestroyedAt?: number }) =>
        void (destroyedAt = w.sandboxDestroyedAt),
      setPlan: async () => {},
      setTrustClass: async () => {},
      reset: async () => void resets++,
      appendLog: async (offset: number, bytes: Uint8Array) =>
        void logs.push(`${offset}:${new TextDecoder().decode(bytes)}`),
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
    return { ctx, logs, resets: () => resets, destroyedAt: () => destroyedAt };
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
