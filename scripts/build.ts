// Cross-compiles the single-file binary for each supported target.
//   bun run scripts/build.ts                 all targets
//   bun run scripts/build.ts bun-darwin-arm64  one or more named targets
// TURNTABLE_SIGN_DARWIN=1 re-signs the darwin binary with rcodesign (ad-hoc) and verifies it.
// Version comes from TURNTABLE_VERSION (a leading "v" is stripped) or root package.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareCompileEntry } from "../packages/ui/scripts/compile-entry";
import { signAdhoc, verifySignature } from "./rcodesign";

const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64"] as const;

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const version = (process.env.TURNTABLE_VERSION ?? pkg.version).replace(/^v/, "");

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : [...TARGETS];
for (const target of targets) {
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new Error(`unknown target ${target}; expected one of ${TARGETS.join(", ")}`);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Builds the web UI and writes the generated entry that embeds it and starts core (main.ts).
const entry = await prepareCompileEntry();

const sums: string[] = [];
for (const target of targets) {
  const name = `turntable-${target.replace(/^bun-/, "")}`;
  const outfile = join(dist, name);
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { target: target as (typeof TARGETS)[number], outfile },
    minify: true,
    define: { TURNTABLE_BUILD_VERSION: JSON.stringify(version) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target}`);
  }
  // Re-sign darwin BEFORE hashing, so SHA256SUMS matches what users download. Release and CI
  // set TURNTABLE_SIGN_DARWIN=1; a plain local build skips the rcodesign download.
  if (target.includes("darwin") && process.env.TURNTABLE_SIGN_DARWIN === "1") {
    await signAdhoc(outfile, name);
    const facts = await verifySignature(outfile, name);
    console.log(`${name}  re-signed (${facts.flags})`);
  }
  const bytes = readFileSync(outfile);
  sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
  const mb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`${name}  ${mb} MiB`);
}

writeFileSync(join(dist, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`wrote dist/SHA256SUMS (version ${version})`);
