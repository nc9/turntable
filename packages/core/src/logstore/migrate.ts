// Copies recent logs from `log_chunks` into the configured external store (#717). Safe to run
// again: an attempt whose store copy already has the same chunk count and size is skipped, and a
// partly copied one is completed: only the offsets the store lacks are written.
// Verification compares chunk count and size per attempt after the copy is flushed.
import type { Db } from "../db";
import { listLoggedAttempts, readLogChunkPage } from "../db/repos/log-migrate";
import { DbLogStore } from "./db-store";
import type { LogStore } from "./types";

export type LogMigrationResult = {
  attempts: number;
  copied: number;
  skipped: number;
  chunks: number;
  bytes: number;
  verified: number;
  mismatches: string[];
};

const PAGE_CHUNKS = 200;
const ATTEMPT_PAGE = 100;
const MAX_MISMATCHES = 50;

export async function migrateLogs(
  db: Db,
  store: LogStore,
  o: { days: number; now: number },
): Promise<LogMigrationResult> {
  const src = new DbLogStore(db);
  const since = o.now - o.days * 86_400_000;
  const out: LogMigrationResult = {
    attempts: 0,
    copied: 0,
    skipped: 0,
    chunks: 0,
    bytes: 0,
    verified: 0,
    mismatches: [],
  };
  let after = "";
  for (;;) {
    const page = await listLoggedAttempts(db, since, after, ATTEMPT_PAGE);
    if (page.length === 0) break;
    for (const key of page) {
      after = key.attemptId;
      out.attempts += 1;
      const want = await src.stat(key);
      const have = await store.stat(key);
      if (have.chunks === want.chunks && have.size === want.size) {
        out.skipped += 1;
        out.verified += 1;
        continue;
      }
      // A partly copied attempt skips the offsets the store already has: the table keeps a second
      // write at an offset as a second row, so copying them again would count them twice.
      const present = new Set<number>();
      if (have.chunks > 0) for (const c of await store.read(key)) present.add(c.offset);
      let from = 0;
      for (;;) {
        const chunks = await readLogChunkPage(db, key, from, PAGE_CHUNKS);
        if (chunks.length === 0) break;
        for (const c of chunks) {
          if (present.has(c.offset)) continue;
          await store.append(key, c.offset, c.bytes);
          out.chunks += 1;
          out.bytes += c.bytes.length;
        }
        from = (chunks.at(-1)?.offset ?? from) + 1;
        // Bound memory: a long log goes in batches.
        await store.flush();
      }
      await store.flush();
      out.copied += 1;
      const got = await store.stat(key);
      if (got.chunks === want.chunks && got.size === want.size) out.verified += 1;
      else if (out.mismatches.length < MAX_MISMATCHES) {
        out.mismatches.push(
          `${key.attemptId}: db ${want.chunks} chunks ${want.size} bytes, store ${got.chunks} chunks ${got.size} bytes`,
        );
      }
    }
  }
  return out;
}
