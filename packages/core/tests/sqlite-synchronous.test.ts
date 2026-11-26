import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { onPostgres } from "./pg-mode";

// About SQLite itself: under the Postgres suite openDatabase is a Postgres handle.
test.skipIf(onPostgres)("a file database opens in WAL with synchronous NORMAL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-sync-"));
  try {
    const db = openDatabase(join(dir, "turntable.db"));
    const row = await db.run(async (h) => {
      const c = (h.orm as unknown as { $client: { query: (q: string) => { get: () => unknown } } })
        .$client;
      return {
        journal: c.query("PRAGMA journal_mode").get() as { journal_mode: string },
        sync: c.query("PRAGMA synchronous").get() as { synchronous: number },
      };
    });
    expect(row.journal.journal_mode).toBe("wal");
    expect(row.sync.synchronous).toBe(1); // NORMAL
    db.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
