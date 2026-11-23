import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import golden from "../src/db/migration-shas.json";
import { EDITED_IN_PLACE, migrationSha } from "../src/db/migration-sha";
import { migrations as sqliteMigrations } from "../src/db/migrations.generated";
import { migrations as pgMigrations } from "../src/db/migrations.pg.generated";

// Pins the hash of every shipped migration. The hash is computed over the generator's split
// statements, so a change to gen-migrations.ts, to drizzle-kit or to whitespace in an old
// migration would refuse boot on every existing instance. This fails before that ships.
const RULES =
  "Rules: a new migration appends its entry to src/db/migration-shas.json in its own PR (db:generate " +
  "does it). An existing entry may change ONLY if its tag is also in EDITED_IN_PLACE " +
  "(src/db/migration-sha.ts) with a reason, because a changed hash refuses boot on every database " +
  "that already applied the migration.";

/** tag -> sha, built in memory from the file's records. */
const pinsOf = (records: readonly { tag: string; sha256: string }[]): Record<string, string> =>
  Object.fromEntries(records.map((r) => [r.tag, r.sha256]));

const dialects = [
  ["sqlite", sqliteMigrations, pinsOf(golden.sqlite)],
  ["pg", pgMigrations, pinsOf(golden.pg)],
] as const;

for (const [name, list, pins] of dialects) {
  describe(`golden migration hashes (${name})`, () => {
    test("every migration has an entry and no entry is orphaned", () => {
      const missing = list.filter((m) => !(m.tag in pins)).map((m) => m.tag);
      const orphaned = Object.keys(pins).filter((t) => !list.some((m) => m.tag === t));
      expect({ missing, orphaned, rules: RULES }).toEqual({
        missing: [],
        orphaned: [],
        rules: RULES,
      });
    });

    test("every migration's current hash equals its golden entry", () => {
      const changed = list
        .filter((m) => m.tag in pins && migrationSha(m) !== pins[m.tag])
        .map((m) => ({ tag: m.tag, golden: pins[m.tag], current: migrationSha(m) }));
      expect({ changed, rules: RULES }).toEqual({ changed: [], rules: RULES });
    });
  });
}

test("an edited-in-place tag does not pin one of its superseded hashes", () => {
  for (const [tag, entry] of Object.entries(EDITED_IN_PLACE)) {
    const pinned = golden.sqlite.find((r) => r.tag === tag)?.sha256;
    expect(pinned).toBeDefined();
    expect(entry.shas).not.toContain(pinned!);
  }
});

// The file is a list of records, never a map keyed by tag: a key such as "0030_instance_tokens"
// beside a 64-hex value reads as a credential to secret scanners (GitGuardian flagged it).
describe("the golden file format", () => {
  const text = readFileSync(join(import.meta.dir, "../src/db/migration-shas.json"), "utf8");

  test("no tag is ever in a key position", () => {
    expect(text).not.toMatch(/"\d{4}_[A-Za-z0-9_]+"\s*:/);
  });

  test("each dialect is a list of exactly { tag, sha256 } records, in tag order, with no repeats", () => {
    for (const records of [golden.sqlite, golden.pg]) {
      expect(Array.isArray(records)).toBe(true);
      for (const r of records) {
        expect(Object.keys(r).toSorted()).toEqual(["sha256", "tag"]);
        expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      const tags = records.map((r) => r.tag);
      expect(tags).toEqual(tags.toSorted());
      expect(new Set(tags).size).toBe(tags.length);
    }
  });
});
