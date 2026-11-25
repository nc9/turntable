import { expect, test } from "bun:test";
import { createAndPrune, type BackupDeps } from "./cd/backup";

// A fake platform: a clock, a backup list, and scripted behaviour.
function fake(o: {
  existing: { id: string; at: number }[];
  appearAfterMs?: number | null;
  inProgress?: number;
  keepVisibleAfterDelete?: number;
}) {
  let clock = 1_000_000;
  const backups = o.existing.map((b) => ({ id: b.id, createdAt: new Date(b.at).toISOString() }));
  const calls: string[] = [];
  let createdAtClock: number | null = null;
  let inProgress = o.inProgress ?? 0;
  const pendingDelete: { id: string; at: number }[] = [];
  const deps: BackupDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    gql: async <T>(query: string, v: Record<string, unknown>): Promise<T> => {
      for (const p of pendingDelete.filter((p) => clock >= p.at)) {
        backups.splice(
          backups.findIndex((b) => b.id === p.id),
          1,
        );
        pendingDelete.splice(pendingDelete.indexOf(p), 1);
      }
      if (query.includes("volumeInstanceBackupCreate")) {
        calls.push("create");
        createdAtClock = clock;
        return { volumeInstanceBackupCreate: { workflowId: "w" } } as T;
      }
      if (query.includes("volumeInstanceBackupList")) {
        if (
          o.appearAfterMs !== null &&
          createdAtClock !== null &&
          clock >= createdAtClock + (o.appearAfterMs ?? 0) &&
          !backups.some((b) => b.id === "NEW")
        ) {
          backups.push({ id: "NEW", createdAt: new Date(createdAtClock + 1).toISOString() });
        }
        return { volumeInstanceBackupList: [...backups] } as T;
      }
      const id = v.volumeInstanceBackupId as string;
      if (inProgress > 0) {
        inProgress--;
        calls.push(`busy:${id}`);
        throw new Error("Backup deletion already in progress");
      }
      calls.push(`delete:${id}`);
      pendingDelete.push({ id, at: clock + (o.keepVisibleAfterDelete ?? 0) });
      return { volumeInstanceBackupDelete: { workflowId: "d" } } as T;
    },
  };
  return { deps, calls, backups };
}
const t0 = 500_000;
const ex = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `B${i + 1}`, at: t0 + i * 1000 }));

test("creates, waits for the new backup to appear, and prunes to 3", async () => {
  const f = fake({ existing: ex(4), appearAfterMs: 20_000 });
  const r = await createAndPrune(f.deps, { volumeInstanceId: "vol" });
  expect(r.backupId).toBe("NEW");
  expect(f.calls[0]).toBe("create");
  expect(f.backups.map((b) => b.id)).toEqual(["B3", "B4", "NEW"]);
});

test("a backup that never appears aborts without deleting anything", async () => {
  const f = fake({ existing: ex(5), appearAfterMs: null });
  await expect(
    createAndPrune(f.deps, { volumeInstanceId: "vol", appearTimeoutMs: 60_000 }),
  ).rejects.toThrow(/did not appear/);
  expect(f.calls).toEqual(["create"]);
});

test("prunes oldest first, one at a time", async () => {
  const f = fake({ existing: ex(6), keepVisibleAfterDelete: 12_000 });
  const r = await createAndPrune(f.deps, { volumeInstanceId: "vol" });
  expect(r.deleted).toEqual(["B1", "B2", "B3", "B4"]);
  expect(f.calls.filter((c) => c.startsWith("delete"))).toEqual([
    "delete:B1",
    "delete:B2",
    "delete:B3",
    "delete:B4",
  ]);
  expect(f.backups.map((b) => b.id)).toEqual(["B5", "B6", "NEW"]);
});

test("never deletes while fewer than keep+1 exist, and never the new backup", async () => {
  const few = fake({ existing: ex(2) });
  expect((await createAndPrune(few.deps, { volumeInstanceId: "vol" })).deleted).toEqual([]);
  const exact = fake({ existing: ex(3) });
  expect((await createAndPrune(exact.deps, { volumeInstanceId: "vol", keep: 4 })).deleted).toEqual(
    [],
  );
  // The new backup is the newest, so it survives even with keep 1.
  const one = fake({ existing: ex(3) });
  const r = await createAndPrune(one.deps, { volumeInstanceId: "vol", keep: 1 });
  expect(one.backups.map((b) => b.id)).toEqual(["NEW"]);
  expect(r.deleted).not.toContain("NEW");
});

test("retries a deletion that is already in progress", async () => {
  const f = fake({ existing: ex(4), inProgress: 2 });
  const r = await createAndPrune(f.deps, { volumeInstanceId: "vol" });
  expect(f.calls.filter((c) => c.startsWith("busy"))).toEqual(["busy:B1", "busy:B1"]);
  expect(r.deleted).toEqual(["B1", "B2"]);
});

test("gives up when deletion stays in progress, and rethrows other errors", async () => {
  const f = fake({ existing: ex(4), inProgress: 99 });
  await expect(
    createAndPrune(f.deps, { volumeInstanceId: "vol", deleteRetries: 3 }),
  ).rejects.toThrow(/in progress/);
  await expect(
    createAndPrune(fake({ existing: [] }).deps, { volumeInstanceId: "v", keep: 0 }),
  ).rejects.toThrow(/keep/);
});
