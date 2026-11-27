// The real main, as an entry the boot tests can steer. Bun.main is this file, so the supervisor
// starts its child as `bun main-lane-boot.ts serve --roles release ...`: the child then does what
// a file next to its data directory says before it would load the real main, or loads it.
//  - child, mode `exit`: exits non-zero at once (a lane that dies while the server boots).
//  - child, mode `hang`: stays alive and never opens the channel (a lane that is never healthy).
//  - parent, TT_TEST_SPAWN_FAIL=1: the binary path is one that does not exist (a spawn that throws).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv;
const isChild = argv.includes("release");
if (isChild) {
  const dataDir = argv[argv.indexOf("--data-dir") + 1]!;
  const modeFile = join(dirname(dataDir), "child-mode");
  const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "";
  if (mode === "exit") process.exit(3);
  if (mode === "hang") setInterval(() => {}, 1000);
}
if (isChild && existsSync(join(dirname(argv[argv.indexOf("--data-dir") + 1]!), "child-mode"))) {
  // Held above: nothing more to run.
} else {
  if (process.env.TT_TEST_SPAWN_FAIL === "1") {
    Object.defineProperty(process, "execPath", { value: "/nonexistent/turntable-bin" });
  }
  await import("../../src/main");
}
