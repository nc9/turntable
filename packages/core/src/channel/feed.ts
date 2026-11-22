// The loop behind the channel: long-poll the `events` operation from a cursor, keep only what the
// filter lets through, look up the few facts a notification needs, and hand each notification
// on. The cursor moves only after an event is handled and is saved each time, so a dropped
// connection or a restart resumes after the last handled event: nothing is lost, and nothing
// handled is sent twice.
import { ChannelApiError, type ChannelApi, type FeedEvent, type RunInfo } from "./api";
import { filterNeedsBranch, matchesBranch, matchesEvent, type ChannelFilter } from "./filter";
import { formatEvent, formatOverflow, formatStopped, type Notification } from "./format";
import type { CursorStore } from "./state";

export const POLL_WAIT_MS = 25_000;
const PAGE = 100;
const MAX_PER_BATCH = 10;
const RUN_CACHE_MS = 30_000;
const RUN_CACHE_MAX = 200;

const branchOf = (run: RunInfo): string | null =>
  run.head_branch ?? (run.ref.startsWith("refs/heads/") ? run.ref.slice(11) : null);

export type FeedOptions = {
  api: ChannelApi;
  filter: ChannelFilter;
  store: CursorStore;
  baseUrl: URL;
  org: string;
  notify: (n: Notification) => Promise<void>;
  signal: AbortSignal;
  waitMs?: number;
  maxPerBatch?: number;
  /** Test seam: resolves after `ms`, or early on abort. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
};

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export async function runFeed(o: FeedOptions): Promise<"aborted" | "auth"> {
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const max = o.maxPerBatch ?? MAX_PER_BATCH;
  const runCache = new Map<string, { at: number; run: RunInfo | null }>();
  let backoff = 1000;

  async function runOf(runId: string): Promise<RunInfo | null> {
    const hit = runCache.get(runId);
    if (hit && now() - hit.at < RUN_CACHE_MS) return hit.run;
    const run = await o.api.getRun(runId, o.signal);
    if (runCache.size >= RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value as string);
    runCache.set(runId, { at: now(), run });
    return run;
  }

  async function handle(e: FeedEvent): Promise<Notification | null> {
    const run = e.run_id ? await runOf(e.run_id) : null;
    if (filterNeedsBranch(o.filter) && !matchesBranch(o.filter, run ? branchOf(run) : null))
      return null;
    let steps: Awaited<ReturnType<ChannelApi["failingSteps"]>> = [];
    if (e.type === "run.finished" && e.run_id) {
      try {
        steps = await o.api.failingSteps(e.run_id, o.signal);
      } catch (err) {
        if (err instanceof ChannelApiError && err.fatal) throw err;
        if (o.signal.aborted) throw err;
        // The notice is still true without step names.
      }
    }
    return formatEvent({ event: e, run, steps, baseUrl: o.baseUrl, org: o.org });
  }

  let cursor = o.store.load();
  while (!o.signal.aborted) {
    try {
      if (cursor === null) {
        // First start: skip history. `after: "now"` returns the tip without reading the feed.
        const tip = await o.api.events({
          after: "now",
          types: [...o.filter.types],
          limit: 1,
          waitMs: 0,
          signal: o.signal,
        });
        cursor = tip.next_after;
        o.store.save(cursor);
      }
      const page = await o.api.events({
        after: cursor,
        types: [...o.filter.types],
        limit: PAGE,
        waitMs: o.waitMs ?? POLL_WAIT_MS,
        signal: o.signal,
      });
      backoff = 1000;
      let sent = 0;
      let skipped = 0;
      for (const e of page.events) {
        if (matchesEvent(o.filter, e)) {
          if (sent >= max) {
            skipped++;
          } else {
            const n = await handle(e);
            if (n) {
              await o.notify(n);
              sent++;
            }
          }
        }
        cursor = e.cursor;
        o.store.save(cursor);
      }
      if (skipped > 0) await o.notify(formatOverflow(skipped));
      if (page.next_after > cursor) {
        cursor = page.next_after;
        o.store.save(cursor);
      }
    } catch (err) {
      if (o.signal.aborted) break;
      if (err instanceof ChannelApiError && err.fatal) {
        log(`token rejected (${err.status})`);
        await o.notify(formatStopped("auth")).catch(() => {});
        return "auth";
      }
      log(
        `feed error, retrying in ${Math.round(backoff / 1000)}s: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(backoff + Math.floor(Math.random() * backoff * 0.2), o.signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  return "aborted";
}
