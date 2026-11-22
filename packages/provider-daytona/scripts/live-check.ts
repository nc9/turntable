// Runs the Daytona conformance suite against the real service ONCE, from this machine.
//
//   bun run packages/provider-daytona/scripts/live-check.ts
//
// The API key is read from ~/.secrets (DAYTONA_API_KEY) into this process and handed to the test
// run through its environment. It is never printed, logged or put on a command line. Afterwards
// the script reports sandbox-minutes used and confirms none of our sandboxes are left.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DaytonaProvider, OWN_LABEL, OWN_LABEL_VALUE, type UsageRecord } from "../src/index";
import { readEnvFileVar } from "./env-file";

const text = readFileSync(join(homedir(), ".secrets"), "utf8");
const key = readEnvFileVar(text, "DAYTONA_API_KEY");
if (!key) {
  console.error("DAYTONA_API_KEY not found in ~/.secrets");
  process.exit(1);
}
process.env.DAYTONA_API_KEY = key;

const provider = new DaytonaProvider({
  apiKey: { env: "DAYTONA_API_KEY" },
  maxLive: 2,
  runId: "live-check",
});
await provider.healthcheck();
const before = await provider.count({});
console.log(`preflight: key accepted; our sandboxes already in the account: ${before}`);
if (before > 0) {
  console.error(
    `refusing to start: sandboxes labelled ${OWN_LABEL}=${OWN_LABEL_VALUE} already exist (not ours to delete blindly)`,
  );
  process.exit(1);
}

const usageLog = join(tmpdir(), `tt-daytona-usage-${Date.now()}.jsonl`);
const started = Date.now();
const proc = Bun.spawn(
  ["bun", "test", "packages/provider-daytona/tests/conformance.test.ts", "--timeout", "300000"],
  {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, TT_DAYTONA_CONFORMANCE: "1", TT_DAYTONA_USAGE_LOG: usageLog },
    stdout: "inherit",
    stderr: "inherit",
  },
);
const code = await proc.exited;
const wall = Math.round((Date.now() - started) / 1000);

let records: UsageRecord[] = [];
try {
  records = readFileSync(usageLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UsageRecord);
} catch {
  // no sandbox was ever deleted
}
const seconds = records.reduce((n, r) => n + r.seconds, 0);

// Whatever the test run left behind (it should be nothing), delete by our own label only.
let leftover = await provider.count({});
let swept = 0;
if (leftover > 0) {
  swept = await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE });
  leftover = await provider.count({});
}
console.log("");
console.log(`conformance exit code: ${code} (wall ${wall}s)`);
console.log(`sandboxes created and deleted: ${records.length}`);
console.log(
  `sandbox-seconds: ${seconds} = ${(seconds / 60).toFixed(1)} sandbox-minutes (${records.length} sandboxes, each billed at least its lifetime)`,
);
console.log(`left behind by the run: ${swept}; our sandboxes remaining now: ${leftover}`);
process.exit(code !== 0 || leftover !== 0 ? 1 : 0);
