// The toolchain that builds a release is named in several files. They must agree, or a release
// could be built with a different bun than CI tested.
//
//   bun run scripts/toolchain-versions.ts          exits 1 and lists every disagreement
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Mention {
  file: string;
  line: number;
  version: string;
}

/** Every bun version named in workflows (`bun-version:`) and Dockerfiles (`oven/bun:<v>`). */
export function bunMentions(files: { name: string; text: string }[]): Mention[] {
  const out: Mention[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((l, i) => {
      const w = /^\s*bun-version:\s*["']?([0-9][0-9A-Za-z.+-]*)["']?\s*(?:#.*)?$/.exec(l);
      const d = /^\s*FROM\s+oven\/bun:([0-9][0-9A-Za-z.+-]*)(?:@sha256:[0-9a-f]{64})?\b/.exec(l);
      const v = w?.[1] ?? d?.[1];
      if (v) out.push({ file: f.name, line: i + 1, version: v });
    });
  }
  return out;
}

/** Empty when every mention names the same version (and there is at least one). */
export function disagreements(m: Mention[]): string[] {
  if (m.length === 0) return ["no bun version found: the check is looking in the wrong place"];
  const versions = [...new Set(m.map((x) => x.version))];
  if (versions.length === 1) return [];
  return m.map((x) => `${x.file}:${x.line} names bun ${x.version} (found ${versions.join(", ")})`);
}

export function collect(root: string): { name: string; text: string }[] {
  const names = [
    ...readdirSync(join(root, ".github/workflows"))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `.github/workflows/${f}`),
    "Dockerfile",
  ];
  return names.map((name) => ({ name, text: readFileSync(join(root, name), "utf8") }));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const problems = disagreements(bunMentions(collect(root)));
  if (problems.length > 0) {
    console.error("the bun version is not the same everywhere:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("toolchain: every workflow and the Dockerfile name the same bun version");
}
