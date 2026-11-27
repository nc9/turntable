// What a dropped chunk means (#717, #690 semantics): the stored log is missing bytes. The drops of
// one attempt are folded into one cut (log_cuts, which is what `log_incomplete` reads) and one
// notice that says so, written to the main database on a short timer so a long outage costs a
// few rows, not one per chunk.
import { addCut, addNotice, type Db } from "../db";
import type { LogKey } from "./types";

export const LOG_STORE_CUT_REASON = "log_store_unavailable";
export const LOG_STORE_NOTICE =
  "log output was lost: the log store was unreachable and its write queue was full";

export function createDropReporter(
  db: Db,
  o: { delayMs?: number; onError?: (err: unknown) => void } = {},
): { report(key: LogKey, offset: number, bytes: number): void; settled(): Promise<void> } {
  const pending = new Map<string, { key: LogKey; at: number; omitted: number }>();
  const noticed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    const batch = [...pending.values()];
    pending.clear();
    for (const p of batch) {
      const scope = { orgId: p.key.orgId, projectId: p.key.projectId };
      try {
        await addCut(db, scope, {
          attemptId: p.key.attemptId,
          atOffset: p.at,
          omittedBytes: p.omitted,
          reason: LOG_STORE_CUT_REASON,
        });
        // One notice per attempt, however many drains an outage takes.
        if (noticed.has(p.key.attemptId)) continue;
        if (noticed.size > 10_000) noticed.clear();
        noticed.add(p.key.attemptId);
        await addNotice(db, scope, {
          attemptId: p.key.attemptId,
          source: "log-store",
          text: LOG_STORE_NOTICE,
          atOffset: p.at,
        });
      } catch (err) {
        o.onError?.(err);
      }
    }
  };

  return {
    report(key, offset, bytes) {
      const id = `${key.attemptId}`;
      const cur = pending.get(id);
      if (cur) {
        cur.at = Math.min(cur.at, offset);
        cur.omitted += bytes;
      } else {
        pending.set(id, { key, at: offset, omitted: bytes });
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          running = running.then(drain);
        }, o.delayMs ?? 1000);
        timer.unref?.();
      }
    },
    async settled() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        running = running.then(drain);
      }
      await running;
    },
  };
}
