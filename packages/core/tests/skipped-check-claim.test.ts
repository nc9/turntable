// Two workers sweeping the same skipped job must post one check run, and a claim whose holder
// died before posting must expire and be retried (#298).
import { beforeEach, describe, expect, test } from "bun:test";
import {
  claimSkippedCheck,
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  listAttempts,
  listJobs,
  releaseSkippedCheckClaim,
  setProjectChecksMode,
} from "../src/db";
import { CheckReporter, SKIP_CLAIM_TTL_MS, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { jobAttempts, jobs } from "../src/db/schema";
import { setupChecksWorld } from "./checks-helpers";

/** An api whose `create` waits on a gate, so every racer has passed `find` before any creates. */
function gatedApi() {
  const runs = new Map<string, CheckRunBody>();
  let creates = 0;
  let finds = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      await gate;
      const id = String(900 + creates++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId(_t, _repo, _sha, name, externalId) {
      finds++;
      for (const [id, b] of runs) if (b.external_id === externalId && b.name === name) return id;
      return undefined;
    },
  };
  return { api, runs, open, creates: () => creates, finds: () => finds };
}
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

let db: Db;
let world: Awaited<ReturnType<typeof setupChecksWorld>>;
beforeEach(async () => {
  world = await setupChecksWorld();
  db = world.db;
  await setProjectChecksMode(db, world.scope, "live");
});

const rep = (api: CheckRunsApi, now?: () => number) =>
  new CheckReporter({ db, auth, api, sleep: async () => {}, ...(now ? { now } : {}) });

async function skippedJob() {
  const run = await createRun(db, world.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: world.sha,
    repo: "acme/web",
  });
  const job = (await createJob(db, world.scope, {
    runId: run.id,
    jobKey: "gated",
    name: "gated",
    needs: [],
    planned: {
      key: "gated",
      id: "gated",
      name: "gated",
      needs: [],
      needsIds: [],
      continueOnError: false,
      outputs: {},
      failFast: true,
      ifExpr: "false",
    },
  }))!;
  const attempt = (await createAttempt(db, world.scope, { jobId: job.id, provider: "fake" }))!;
  await db.run((h) => h.orm.update(jobAttempts).set({ state: "skipped" }));
  await db.run((h) => h.orm.update(jobs).set({ state: "skipped" }));
  return { run, job, attemptId: attempt.id };
}

const claimedAt = async (): Promise<number | null> =>
  (await db.run((h) => h.orm.select().from(jobAttempts)))[0]!.skipCheckClaimedAt;

describe("claiming a skipped check", () => {
  test("two sweeps at once post exactly one check", async () => {
    const { run, attemptId } = await skippedJob();
    const g = gatedApi();
    const a = rep(g.api);
    const b = rep(g.api);
    const sweeps = Promise.all([a.sweepSkipped(), b.sweepSkipped()]);
    // let both reach the gate (the winner is inside create; the loser has stopped at the claim)
    await new Promise((r) => setTimeout(r, 50));
    g.open();
    await sweeps;
    await Promise.all([a.idle(), b.idle()]);
    expect(g.creates()).toBe(1);
    expect(g.runs.size).toBe(1);
    const [att] = await listAttempts(
      db,
      world.scope,
      (await listJobs(db, world.scope, run.id))[0]!.id,
    );
    expect(att!.id).toBe(attemptId);
    expect(await getAttemptCheckRunId(db, world.scope, attemptId)).toBe("900");
  });

  test("a claim that is still live blocks another worker, and posts nothing", async () => {
    const { attemptId } = await skippedJob();
    const t0 = Date.now();
    await db.run((h) => h.orm.update(jobAttempts).set({ skipCheckClaimedAt: t0 }));
    const g = gatedApi();
    g.open();
    await rep(g.api, () => t0 + SKIP_CLAIM_TTL_MS - 1).sweepSkipped();
    expect(g.creates()).toBe(0);
    expect(await getAttemptCheckRunId(db, world.scope, attemptId)).toBeNull();
  });

  test("an expired claim is retried and the job gets its check", async () => {
    const { attemptId } = await skippedJob();
    const t0 = Date.now();
    // a worker took the claim and died before posting
    await db.run((h) => h.orm.update(jobAttempts).set({ skipCheckClaimedAt: t0 }));
    const g = gatedApi();
    g.open();
    await rep(g.api, () => t0 + SKIP_CLAIM_TTL_MS + 1).sweepSkipped();
    expect(g.creates()).toBe(1);
    expect(await getAttemptCheckRunId(db, world.scope, attemptId)).toBe("900");
  });

  test("a failed post releases the claim so the next sweep retries at once", async () => {
    const { attemptId } = await skippedJob();
    const g = gatedApi();
    g.open();
    const failing: CheckRunsApi = {
      ...g.api,
      create: async () => {
        throw new Error("boom");
      },
    };
    const now = Date.now();
    await rep(failing, () => now).sweepSkipped();
    expect(await getAttemptCheckRunId(db, world.scope, attemptId)).toBeNull();
    expect(await claimedAt()).toBeNull();
    await rep(g.api, () => now).sweepSkipped();
    expect(g.creates()).toBe(1);
  });

  test("a stalled holder's failed post cannot release the claim another worker retook", async () => {
    const { attemptId } = await skippedJob();
    const t0 = Date.now();
    const a = await claimSkippedCheck(db, world.scope, attemptId, t0, SKIP_CLAIM_TTL_MS);
    expect(a).toBe(t0);
    // A stalls past the TTL; B retakes the claim
    const t1 = t0 + SKIP_CLAIM_TTL_MS + 1;
    const b = await claimSkippedCheck(db, world.scope, attemptId, t1, SKIP_CLAIM_TTL_MS);
    expect(b).toBe(t1);
    // A's post fails and it releases with its own stamp: B's live claim must survive
    await releaseSkippedCheckClaim(db, world.scope, attemptId, a!);
    expect(await claimedAt()).toBe(t1);
    // so a third sweep C cannot claim
    expect(
      await claimSkippedCheck(db, world.scope, attemptId, t1 + 1, SKIP_CLAIM_TTL_MS),
    ).toBeNull();
    // B's own release still works
    await releaseSkippedCheckClaim(db, world.scope, attemptId, b!);
    expect(await claimedAt()).toBeNull();
  });
});
