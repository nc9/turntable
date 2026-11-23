import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Provider } from "@turntable/provider-sdk";
import { createAttempt, createJob, type Db, getAttempt } from "../src/db";
import * as s from "../src/db/schema";
import {
  adoptRecordedSandboxes,
  SWEEP_GRACE_MS,
  sweepUndestroyedSandboxes,
} from "../src/scheduler/reconcile";
import { seedWorld, type Tenant } from "./ops-helpers";

const NOW = 1_800_000_000_000;
let db: Db;
let a: Tenant;
let adopted: string[];
let destroyed: string[];
let failFor: Set<string>;

const provider = (withAdopt = true): Provider =>
  ({
    ...(withAdopt ? { adopt: (ids: readonly string[]) => void adopted.push(...ids) } : {}),
    destroy: async (id: string) => {
      if (failFor.has(id)) throw new Error("delete failed");
      destroyed.push(id);
    },
  }) as unknown as Provider;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  adopted = [];
  destroyed = [];
  failFor = new Set();
});

async function attempt(
  sandboxId: string | null,
  state: string,
  over: { finishedAt?: number | null; destroyedAt?: number | null; provider?: string } = {},
): Promise<string> {
  const job = (await createJob(db, a.scope, {
    runId: a.runId,
    jobKey: `j-${Math.random().toString(36).slice(2)}`,
    name: "j",
  }))!;
  const at = (await createAttempt(db, a.scope, { jobId: job.id, provider: "daytona" }))!;
  await db.orm
    .update(s.jobAttempts)
    .set({
      sandboxId,
      state,
      finishedAt: over.finishedAt === undefined ? NOW - 10 * SWEEP_GRACE_MS : over.finishedAt,
      sandboxDestroyedAt: over.destroyedAt ?? null,
      provider: over.provider ?? "daytona",
    })
    .where(eq(s.jobAttempts.id, at.id));
  return at.id;
}

describe("handing recorded sandboxes to the provider", () => {
  test("every attempt with a sandbox and no confirmed destroy is adopted, in any state", async () => {
    await attempt("sbx-running", "running", { finishedAt: null });
    await attempt("sbx-failed", "failure");
    await attempt("sbx-done", "success", { destroyedAt: NOW - 1 });
    await attempt(null, "queued", { finishedAt: null });
    const n = await adoptRecordedSandboxes(db, (name) =>
      name === "daytona" ? provider() : undefined,
    );
    expect(adopted.toSorted()).toEqual(["sbx-failed", "sbx-running"]);
    expect(n).toBe(2);
  });

  test("a provider without adopt, or an unknown one, is skipped without error", async () => {
    await attempt("sbx-1", "failure");
    expect(await adoptRecordedSandboxes(db, () => provider(false))).toBe(0);
    expect(await adoptRecordedSandboxes(db, () => undefined)).toBe(0);
  });
});

describe("sweeping finished attempts whose sandbox was never confirmed destroyed", () => {
  test("destroys by id, records the confirmed destroy, and leaves running and recent ones alone", async () => {
    const failed = await attempt("sbx-failed", "failure");
    const cancelled = await attempt("sbx-cancelled", "cancelled");
    const running = await attempt("sbx-running", "running", { finishedAt: null });
    const recent = await attempt("sbx-recent", "success", { finishedAt: NOW - 1000 });
    const done = await attempt("sbx-done", "success", { destroyedAt: NOW - 5000 });
    const r = await sweepUndestroyedSandboxes(db, () => provider(), { now: () => NOW });
    expect(r).toEqual({ destroyed: 2, failed: 0 });
    expect(destroyed.toSorted()).toEqual(["sbx-cancelled", "sbx-failed"]);
    for (const id of [failed, cancelled]) {
      expect((await getAttempt(db, a.scope, id))?.sandboxDestroyedAt).toBe(NOW);
    }
    for (const id of [running, recent]) {
      expect((await getAttempt(db, a.scope, id))?.sandboxDestroyedAt).toBeNull();
    }
    expect((await getAttempt(db, a.scope, done))?.sandboxDestroyedAt).toBe(NOW - 5000);
  });

  test("a destroy that fails records nothing and is retried on the next sweep", async () => {
    const id = await attempt("sbx-stuck", "infra_error");
    failFor.add("sbx-stuck");
    const logs: string[] = [];
    expect(
      await sweepUndestroyedSandboxes(db, () => provider(), {
        now: () => NOW,
        log: (m) => logs.push(m),
      }),
    ).toEqual({ destroyed: 0, failed: 1 });
    expect((await getAttempt(db, a.scope, id))?.sandboxDestroyedAt).toBeNull();
    expect(logs.join("\n")).toContain("sbx-stuck");
    failFor.clear();
    expect(await sweepUndestroyedSandboxes(db, () => provider(), { now: () => NOW })).toEqual({
      destroyed: 1,
      failed: 0,
    });
    expect((await getAttempt(db, a.scope, id))?.sandboxDestroyedAt).toBe(NOW);
    // And a swept one is not swept again.
    destroyed.length = 0;
    await sweepUndestroyedSandboxes(db, () => provider(), { now: () => NOW });
    expect(destroyed).toEqual([]);
  });
});
