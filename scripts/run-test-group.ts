// Runs one test group: `bun scripts/run-test-group.ts <group>` is `bun test <files>` for the
// paths in scripts/test-groups/<group>.txt. The `test:*` scripts in package.json call this, so
// the file lists are not on the package.json lines (see scripts/test-groups.ts).
import { readGroup } from "./test-groups";

// Default per-test timeout under CI load (bun's 5 s default flakes). bunfig `[test] timeout` is ignored by
// bun 1.4.5, so the flag is the mechanism. Explicit per-test timeouts still win.
const TEST_TIMEOUT_MS = "30000";

const group = process.argv[2];
if (!group || process.argv.length > 3) throw new Error("usage: run-test-group.ts <group>");

const proc = Bun.spawn(["bun", "test", "--timeout", TEST_TIMEOUT_MS, ...readGroup(group)], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await proc.exited);
