// The events table has no CHECK on `type` (the last rebuild dropped it, #345), so the list in
// EVENT_TYPES is the only gate. Every type the code emits must be in it, and an unknown one is refused.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { appendEvent } from "../src/db/repos/events";
import { EVENT_TYPES } from "../src/db/schema";
import * as pgSchema from "../src/db/schema.pg";
import * as sqliteSchema from "../src/db/schema.sqlite";

/** Every dotted-name literal given as `type` to an appendEvent call. */
async function emitted(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const root = new URL("../src/", import.meta.url).pathname;
  for await (const file of new Glob("**/*.ts").scan(root)) {
    if (file.includes("generated")) continue;
    const text = await Bun.file(root + file).text();
    if (!/\bappendEvent\(/.test(text)) continue;
    // Each call's first `type:` property; it may be a ternary, so take every dotted literal in it.
    for (const call of text.matchAll(/\bappendEvent\(/g)) {
      const prop = /\btype:\s*([^,]+),/.exec(text.slice(call.index));
      for (const m of prop?.[1]?.matchAll(/"([a-z_]+\.[a-z_]+)"/g) ?? []) found.set(m[1]!, file);
    }
  }
  return found;
}

test("every event type the code emits is in EVENT_TYPES", async () => {
  const found = await emitted();
  expect(found.size).toBeGreaterThan(8); // the scan found the call sites
  for (const [type, file] of found)
    expect([type, file, EVENT_TYPES.includes(type as never)]).toEqual([type, file, true]);
});

test("every type in EVENT_TYPES is emitted somewhere (no dead entries)", async () => {
  const found = await emitted();
  expect(EVENT_TYPES.filter((t) => !found.has(t))).toEqual([]);
});

test("both dialect schemas list the same types", () => {
  expect([...pgSchema.EVENT_TYPES]).toEqual([...sqliteSchema.EVENT_TYPES]);
});

test("appendEvent refuses an unknown type before touching the database", async () => {
  const db = { run: () => Promise.reject(new Error("reached the database")) };
  await expect(
    appendEvent(db as never, { orgId: "o1" } as never, { type: "not.a_type" as never }),
  ).rejects.toThrow("unknown event type: not.a_type");
});
