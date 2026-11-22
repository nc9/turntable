import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, openDatabase, schema } from "../src/db";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("migrations apply on a fresh database and are idempotent on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longshore-test-"));
  dirs.push(dir);
  const path = join(dir, "nested", "longshore.db");

  const first = openDatabase(path);
  const id = await ensureInstance(first);
  expect(await first.orm.select().from(schema.instance)).toHaveLength(1);
  first.close();

  const second = openDatabase(path);
  expect(await ensureInstance(second)).toBe(id);
  expect(await second.orm.select().from(schema.instance)).toHaveLength(1);
  second.close();
});
