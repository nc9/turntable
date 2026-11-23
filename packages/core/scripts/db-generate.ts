// `bun run --cwd packages/core db:generate [--name <snake_case_name>]`
//
// Runs the whole generation: the pg schema, drizzle-kit for both dialects, and the embedded
// modules. `--name` is passed to both drizzle-kit runs, so the sqlite and pg migrations get the
// same explicit name. Without it drizzle-kit picks a random one (an adjective and a Marvel
// character), which has twice put a customer-like word in a public file: always pass a name.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { name: { type: "string" } },
  strict: true,
});
if (values.name !== undefined && !/^[a-z][a-z0-9_]{0,60}$/.test(values.name)) {
  console.error("--name must be lower snake_case, for example --name instance_tokens");
  process.exit(2);
}
const name = values.name ? ["--name", values.name] : [];
if (!values.name) {
  console.warn(
    "warning: no --name, so drizzle-kit picks a random one; use `db:generate --name <what_it_does>`",
  );
}

const steps: string[][] = [
  ["bun", "run", "scripts/gen-pg-schema.ts"],
  ["bunx", "drizzle-kit", "generate", ...name],
  ["bunx", "drizzle-kit", "generate", "--config", "drizzle.pg.config.ts", ...name],
  ["bun", "run", "scripts/gen-migrations.ts"],
];
for (const [cmd, ...args] of steps) {
  const r = spawnSync(cmd as string, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
