import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, type Migration } from "../src/db/migrate";

// Two processes booting at once must both succeed and leave one sha256 column.
const tiny: Migration[] = [{ tag: "0000_a", when: 1, statements: ["CREATE TABLE a (id INTEGER)"] }];

test("two concurrent boots on one fresh sqlite file both succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-mig-"));
  try {
    const path = join(dir, "t.db");
    const open = () => {
      const db = new Database(path, { create: true, strict: true });
      db.run("PRAGMA busy_timeout = 5000");
      return db;
    };
    const [a, b] = [open(), open()];
    const results = await Promise.allSettled([
      Promise.resolve().then(() => applyMigrations(a, tiny)),
      Promise.resolve().then(() => applyMigrations(b, tiny)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const cols = a
      .query<{ name: string }, []>("PRAGMA table_info(__turntable_migrations)")
      .all()
      .filter((c) => c.name === "sha256");
    expect(cols).toHaveLength(1);
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
