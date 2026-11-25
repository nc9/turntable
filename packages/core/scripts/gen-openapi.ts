// Writes docs/openapi.json from the operations registry. A test (tests/ops-openapi.test.ts)
// fails when the committed file is stale, so CI catches a forgotten run of this script.
//
//   bun run scripts/gen-openapi.ts [--check]
//
// `--check` writes nothing and exits 1 when the committed file differs (compared as parsed JSON,
// so the formatter's whitespace cannot flap it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../src/ops";
import { buildOpenApi } from "../src/ops/openapi";

const out = join(import.meta.dir, "../../../docs/openapi.json");
// A fixed version: the committed document must not change with each build.
const next = `${JSON.stringify(buildOpenApi(registry, "0.0.0-dev"), null, 2)}\n`;
if (process.argv.includes("--check")) {
  let cur = "null";
  try {
    cur = readFileSync(out, "utf8");
  } catch {}
  if (JSON.stringify(JSON.parse(cur)) !== JSON.stringify(JSON.parse(next))) {
    console.error("docs/openapi.json is stale: run bun run openapi:gen");
    process.exit(1);
  }
  console.log("docs/openapi.json is current");
  process.exit(0);
}
writeFileSync(out, next);
// The committed file must pass `bun run format:check`, so format what was just written.
const root = join(import.meta.dir, "../../..");
const fmt = Bun.spawnSync(["bun", "fmt", out], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (fmt.exitCode !== 0) throw new Error(`bun fmt failed with exit ${fmt.exitCode}`);
console.log(`wrote ${out}`);
