// Runs one test group: `bun scripts/run-test-group.ts <group>` is `bun test <files>` for the
// paths in scripts/test-groups/<group>.txt. The `test:*` scripts in package.json call this, so
// the file lists are not on the package.json lines (see scripts/test-groups.ts).
import { readGroup } from "./test-groups";

const group = process.argv[2];
if (!group || process.argv.length > 3) throw new Error("usage: run-test-group.ts <group>");

const proc = Bun.spawn(["bun", "test", ...readGroup(group)], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await proc.exited);
