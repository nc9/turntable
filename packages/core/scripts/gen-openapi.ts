// Writes docs/openapi.json from the operations registry. A test (tests/ops-openapi.test.ts)
// fails when the committed file is stale, so CI catches a forgotten run of this script.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../src/ops";
import { buildOpenApi } from "../src/ops/openapi";

const out = join(import.meta.dir, "../../../docs/openapi.json");
// A fixed version: the committed document must not change with each build.
writeFileSync(out, `${JSON.stringify(buildOpenApi(registry, "0.0.0-dev"), null, 2)}\n`);
// The committed file must pass `bun run format:check`, so format what was just written.
const root = join(import.meta.dir, "../../..");
const fmt = Bun.spawnSync(["bunx", "oxfmt", out], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (fmt.exitCode !== 0) throw new Error(`oxfmt failed with exit ${fmt.exitCode}`);
console.log(`wrote ${out}`);
