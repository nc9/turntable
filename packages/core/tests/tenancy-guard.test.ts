import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";

/**
 * Source guard. Tenant-owned tables may only be touched inside src/db/repos, where every
 * function takes a Scope. Anything else that names a tenant table export (via `schema.x`,
 * `.query.x`, or an import from the schema module) fails this test.
 *
 * It is a lexical check, not a proof: it catches the accidental `db.orm.select().from(runs)`,
 * not deliberate evasion. Reviewers still own the rest. To add a legitimate exception, extend
 * ALLOWED_FILES with a reason.
 */
const SRC = join(import.meta.dir, "../src");
const ALLOWED_FILES = new Set([
  "db/schema.ts", // selects the tables of the dialect
  "db/schema.sqlite.ts", // defines the tables
  "db/schema.pg.ts", // the same tables for Postgres (generated)
  "db/migrations.pg.generated.ts", // data
  "db/migrations.generated.ts", // data
]);
const ALLOWED_DIRS = ["db/repos/"];

// JS export names of tables that have an org_id column.
const tenantExports = Object.entries(schema)
  .filter(
    ([, v]) =>
      v instanceof SQLiteTable && getTableConfig(v).columns.some((c) => c.name === "org_id"),
  )
  .map(([name]) => name);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function violations(file: string, text: string): string[] {
  const out: string[] = [];
  for (const name of tenantExports) {
    const word = `\\b${name}\\b`;
    if (new RegExp(`\\bschema\\.${name}\\b`).test(text)) out.push(`schema.${name}`);
    if (new RegExp(`\\.query\\.${name}\\b`).test(text)) out.push(`.query.${name}`);
    const imp = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*schema["']/g;
    for (const m of text.matchAll(imp)) {
      if (new RegExp(word).test(m[1] ?? "")) out.push(`import ${name}`);
    }
  }
  return out.map((v) => `${file}: ${v}`);
}

test("tenant tables are only queried inside db/repos", () => {
  expect(tenantExports).toContain("runs");
  const bad = walk(SRC).flatMap((path) => {
    const rel = relative(SRC, path);
    if (ALLOWED_FILES.has(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(d))) return [];
    return violations(rel, readFileSync(path, "utf8"));
  });
  expect(bad).toEqual([]);
});

test("the guard itself detects a leak", () => {
  const leaks = violations(
    "x.ts",
    'import { runs } from "./db/schema";\ndb.orm.select().from(schema.jobs)',
  );
  expect(leaks).toContain("x.ts: import runs");
  expect(leaks).toContain("x.ts: schema.jobs");
});
