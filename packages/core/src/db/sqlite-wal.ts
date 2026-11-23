// Opening a SQLite file next to other connections (a server, the CLI, a test's handle): wait for
// their locks instead of failing with "database is locked". A module of its own, with nothing but
// bun:sqlite behind it, so the release lane's small store can use it too.
import type { Database } from "bun:sqlite";

/** How long a SQLite statement waits for another connection's lock before it fails. */
export const BUSY_TIMEOUT_MS = 10_000;

/**
 * Switches the file to WAL, waiting while another connection holds a lock. SQLite does not call
 * the busy handler for this switch (it takes its own exclusive lock), so `busy_timeout` alone does
 * not help: it fails at once with "database is locked". Retried here until the same timeout.
 */
export function enableWal(sqlite: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      sqlite.run("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      const busy = /database is locked|SQLITE_BUSY/i.test(String((err as Error).message));
      if (!busy || Date.now() >= deadline) throw err;
      Bun.sleepSync(25);
    }
  }
}
