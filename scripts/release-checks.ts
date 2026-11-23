// Checks on what a release is about to publish, that need no account and no network:
//
//   bun run scripts/release-checks.ts sums dist                      SHA256SUMS is complete and true
//   bun run scripts/release-checks.ts sbom dist/longshore-X.cdx.json  the SBOM is the lockfile's
//   bun run scripts/release-checks.ts image-sbom longshore-image.cdx.json   a usable image SBOM
//
// The release dry run runs all three, so a release whose checksums, SBOM or image SBOM are wrong
// fails before a tag is ever pushed.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseLock } from "./lockfile";
import { purl, shippedPackages } from "./sbom";

export const BINARIES = [
  "longshore-linux-x64",
  "longshore-linux-arm64",
  "longshore-darwin-arm64",
] as const;
const SBOM_FILE = /^longshore-[0-9][^/]*\.cdx\.json$/;

/**
 * `build.ts` deletes the output directory before it writes. A LONGSHORE_DIST that names `/`, the
 * home directory, the repository or any directory above them would delete far more than a build's
 * output, so it is refused before anything is removed. Returns the resolved directory.
 */
export function assertSafeDist(dist: string, root: string, home: string | undefined): string {
  // The real path of the deepest part that exists (symlinks followed), with the rest appended, so a
  // path that does not exist yet is still compared on the same footing as one that does.
  const real = (p: string): string => {
    let cur = resolve(p);
    const rest: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(cur), ...rest.toReversed());
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return resolve(p);
        rest.push(basename(cur));
        cur = parent;
      }
    }
  };
  const d = real(dist);
  const protectedDirs = [root, ...(home ? [home] : [])].map(real);
  const isAncestorOrSame = (a: string, b: string): boolean =>
    a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
  if (d === sep || /^[A-Za-z]:\\?$/.test(d))
    throw new Error(`refusing LONGSHORE_DIST=${dist}: it is a filesystem root`);
  for (const p of protectedDirs) {
    if (isAncestorOrSame(d, p)) {
      throw new Error(
        `refusing LONGSHORE_DIST=${dist}: it is, or contains, ${p} (the build deletes its output directory first)`,
      );
    }
  }
  return resolve(dist);
}

export interface Problem {
  what: string;
}

/**
 * SHA256SUMS lists exactly the release files: every binary and the SBOM once each, nothing else,
 * each hash equal to the file's, in no other form than `<64 hex>  <name>`.
 */
export function checkSums(dist: string): Problem[] {
  const out: Problem[] = [];
  const sumsPath = join(dist, "SHA256SUMS");
  if (!existsSync(sumsPath)) return [{ what: "dist/SHA256SUMS is missing" }];
  const lines = readFileSync(sumsPath, "utf8").split("\n").filter(Boolean);
  const listed = new Map<string, string>();
  for (const l of lines) {
    const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(l);
    if (!m) {
      out.push({ what: `a line that is not "<sha256>  <name>": ${l.slice(0, 80)}` });
      continue;
    }
    if (listed.has(m[2]!)) out.push({ what: `${m[2]} is listed twice` });
    listed.set(m[2]!, m[1]!);
  }
  const files = readdirSync(dist).filter((f) => f !== "SHA256SUMS");
  for (const b of BINARIES) if (!listed.has(b)) out.push({ what: `${b} is not in SHA256SUMS` });
  const sboms = files.filter((f) => SBOM_FILE.test(f));
  if (sboms.length !== 1)
    out.push({ what: `expected one SBOM file in dist, found ${sboms.length}` });
  for (const [name, hash] of listed) {
    if (!files.includes(name)) {
      out.push({ what: `${name} is listed but not in dist` });
    } else if (
      createHash("sha256")
        .update(readFileSync(join(dist, name)))
        .digest("hex") !== hash
    ) {
      out.push({ what: `${name} does not match its SHA256SUMS entry` });
    }
  }
  for (const f of files) {
    if (!listed.has(f)) out.push({ what: `${f} is in dist but not in SHA256SUMS` });
  }
  return out;
}

interface Bom {
  bomFormat?: unknown;
  specVersion?: unknown;
  components?: { purl?: unknown; hashes?: { alg?: unknown; content?: unknown }[] }[];
}

/** The SBOM names exactly the packages the lockfile ships, each with a purl and a hash. */
export function checkSbom(sbomText: string, lockText: string): Problem[] {
  const out: Problem[] = [];
  let bom: Bom;
  try {
    bom = JSON.parse(sbomText) as Bom;
  } catch {
    return [{ what: "the SBOM is not JSON" }];
  }
  if (bom.bomFormat !== "CycloneDX") out.push({ what: "bomFormat is not CycloneDX" });
  if (typeof bom.specVersion !== "string") out.push({ what: "no specVersion" });
  const have = new Set((bom.components ?? []).map((c) => String(c.purl)));
  const want = new Set(
    shippedPackages(parseLock(lockText))
      .filter((p) => !p.workspace)
      .map((p) => purl(p.name, p.version)),
  );
  if (want.size === 0) out.push({ what: "the lockfile ships no packages (a parse problem?)" });
  for (const p of want) if (!have.has(p)) out.push({ what: `missing from the SBOM: ${p}` });
  for (const p of have) if (!want.has(p)) out.push({ what: `in the SBOM but not shipped: ${p}` });
  for (const c of bom.components ?? []) {
    const ok = (c.hashes ?? []).some(
      (h) =>
        typeof h.alg === "string" && typeof h.content === "string" && /^[0-9a-f]+$/.test(h.content),
    );
    if (!ok) out.push({ what: `no hash for ${String(c.purl)}` });
  }
  return out;
}

/** An image SBOM from Syft is usable: CycloneDX, with the operating system and packages in it. */
export function checkImageSbom(text: string): Problem[] {
  let bom: Bom;
  try {
    bom = JSON.parse(text) as Bom;
  } catch {
    return [{ what: "the image SBOM is not JSON" }];
  }
  const out: Problem[] = [];
  if (bom.bomFormat !== "CycloneDX") out.push({ what: "bomFormat is not CycloneDX" });
  if (typeof bom.specVersion !== "string") out.push({ what: "no specVersion" });
  const n = bom.components?.length ?? 0;
  // The distroless base alone carries dozens of packages; an empty list means the scan saw nothing.
  if (n < 10) out.push({ what: `only ${n} components: the scan did not see the image's packages` });
  return out;
}

function report(name: string, problems: Problem[]): never {
  if (problems.length > 0) {
    console.error(`${name}: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p.what}`);
    process.exit(1);
  }
  console.log(`${name}: ok`);
  process.exit(0);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (!arg) {
    console.error("usage: release-checks.ts <sums dist | sbom file | image-sbom file>");
    process.exit(2);
  }
  if (cmd === "sums") report("SHA256SUMS", checkSums(arg));
  else if (cmd === "sbom") {
    report("SBOM", checkSbom(readFileSync(arg, "utf8"), readFileSync("bun.lock", "utf8")));
  } else if (cmd === "image-sbom") report("image SBOM", checkImageSbom(readFileSync(arg, "utf8")));
  else {
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  }
}
