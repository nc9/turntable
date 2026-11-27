// A stand-in for `turntable serve --roles release`, for the supervisor tests: the real
// `serveRelease` (its environment parse, its channel on the supervisor's socket and keys) with
// fakes for what needs the network or a signing key. Run by the test through the supervisor.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveRelease, type WiringFactory } from "../../src/release/serve";

const SHA = "a".repeat(40);
const dataDir = process.argv[process.argv.indexOf("--data-dir") + 1]!;
// What this process was started with, before anything reads or removes a variable.
writeFileSync(
  join(dataDir, "..", "child-env.json"),
  JSON.stringify(Object.keys(process.env).sort()),
);
const artifactDir = process.env.TURNTABLE_RELEASE_ARTIFACT_DIR!;

const wiring: WiringFactory = () => ({
  signer: {
    signRelease: async () => ({ ok: false, reason: "not_in_this_test" }),
    checkKey: async () => ({ ok: true }),
  } as never,
  records: {
    async recorded(_scope, runId, names) {
      return names.map((name) => {
        const bytes = readFileSync(join(artifactDir, runId, name));
        return {
          name,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        };
      });
    },
  },
});

const lane = await serveRelease({ "data-dir": dataDir }, wiring, process.env, {
  forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
});
const stop = () => {
  lane.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
