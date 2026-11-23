// Reproducibility check: the same commit built twice gives the same bytes.
//
//   bun run scripts/repro-check.ts [--target bun-linux-x64]... [--keep]
//
// The first build is in this checkout; the second is in a fresh copy of HEAD (git archive) at a
// different path, with a fresh `bun install --frozen-lockfile`. So the check also proves that the
// binary does not depend on the checkout's path or on leftover files. Darwin is built unsigned:
// the signature is a separate step with its own verification. Exits 1 and says which binary
// differs. With --expect <SHA256SUMS> the linux binaries must also equal that list (the release
// job's own build). Run by the release dry run, and before a tag is published.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64"] as const;

export interface Compared {
  name: string;
  a: string;
  b: string;
  same: boolean;
}

export function compareHashes(a: Record<string, string>, b: Record<string, string>): Compared[] {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].toSorted();
  return names.map((name) => ({
    name,
    a: a[name] ?? "(missing)",
    b: b[name] ?? "(missing)",
    same: a[name] !== undefined && a[name] === b[name],
  }));
}

/**
 * The linux binaries of a build must equal the ones the release will publish (SHA256SUMS from the
 * `binaries` job). Darwin is left out: it is signed after the compile, so its published hash is not
 * the compile's.
 */
export function checkAgainstSums(
  built: Record<string, string>,
  published: Record<string, string>,
): string[] {
  const linux = Object.keys(built).filter((n) => n.startsWith("turntable-linux-"));
  if (linux.length === 0) return ["no linux binary was built, so nothing could be compared"];
  return linux.flatMap((n) =>
    published[n] === undefined
      ? [`${n} is not in the published SHA256SUMS`]
      : published[n] === built[n]
        ? []
        : [
            `${n} differs from the published SHA256SUMS (${built[n]!.slice(0, 16)} vs ${published[n].slice(0, 16)})`,
          ],
  );
}

/** `<hex>  <name>` lines, as build.ts writes SHA256SUMS. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
    if (m) out[m[2]!] = m[1]!;
  }
  return out;
}

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}): void {
  const r = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env, TURNTABLE_SIGN_DARWIN: "" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${r.exitCode}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string", multiple: true },
      keep: { type: "boolean" },
      expect: { type: "string" },
    },
    strict: true,
  });
  const targets = values.target?.length ? values.target : [...DEFAULT_TARGETS];
  const root = join(import.meta.dir, "..");
  const work = mkdtempSync(join(tmpdir(), "ls-repro-"));
  try {
    const first = join(work, "first");
    run(["bun", "run", "scripts/build.ts", ...targets], root, { TURNTABLE_DIST: first });
    const copy = join(work, "fresh", "checkout-elsewhere");
    run(["mkdir", "-p", copy], root);
    run(["sh", "-c", `git archive HEAD | tar -x -C '${copy}'`], root);
    run(["bun", "install", "--frozen-lockfile"], copy);
    const second = join(work, "second");
    run(["bun", "run", "scripts/build.ts", ...targets], copy, { TURNTABLE_DIST: second });
    const result = compareHashes(
      parseSums(readFileSync(join(first, "SHA256SUMS"), "utf8")),
      parseSums(readFileSync(join(second, "SHA256SUMS"), "utf8")),
    );
    for (const c of result) {
      console.log(
        `${c.same ? "same     " : "DIFFERENT"} ${c.name} ${c.a.slice(0, 16)} ${c.b.slice(0, 16)}`,
      );
    }
    if (result.length === 0 || result.some((c) => !c.same)) {
      console.error("the build is not reproducible");
      process.exit(1);
    }
    console.log(`reproducible: ${result.length} binaries identical across two builds`);
    if (values.expect) {
      const problems = checkAgainstSums(
        parseSums(readFileSync(join(first, "SHA256SUMS"), "utf8")),
        parseSums(readFileSync(values.expect, "utf8")),
      );
      if (problems.length > 0) {
        for (const p of problems) console.error(`  - ${p}`);
        console.error("the rebuilt binaries are not the ones the release job built");
        process.exit(1);
      }
      console.log("the linux binaries equal the release job's SHA256SUMS");
    }
  } finally {
    if (!values.keep) rmSync(work, { recursive: true, force: true });
  }
}
