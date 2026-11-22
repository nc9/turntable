import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrations } from "../src/db/migrations.generated";

const DRIZZLE = join(import.meta.dir, "../drizzle");

test("embedded migrations equal the SQL files and journal on disk", () => {
  const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const fromDisk = journal.entries.map((e) => ({
    tag: e.tag,
    when: e.when,
    statements: readFileSync(join(DRIZZLE, `${e.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
  expect(migrations).toEqual(fromDisk);
});

test("no SQL file on disk is missing from the journal", () => {
  const onDisk = readdirSync(DRIZZLE)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .toSorted();
  expect(migrations.map((m) => m.tag).toSorted()).toEqual(onDisk);
});
