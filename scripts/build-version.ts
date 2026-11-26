// Resolves the build version, sha and time that scripts/build.ts bakes into the binary.
// The base version lives only in root package.json. Versions are compared with `===` only:
// semver precedence would sort dev10 before dev9, so nothing may order them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Semver 2.0.0, strict, no leading "v". packages/core/src/version.ts holds an identical copy. */
export const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function checked(value: string, source: string): string {
  if (!VERSION_RE.test(value)) {
    throw new Error(`invalid build version from ${source}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * env.TURNTABLE_VERSION, else the first line of a BUILD_VERSION file at `root`, else
 * `${pkgVersion}-dev0+${sha8}` (`+unknown` without a sha). Operator values are used verbatim.
 */
export function resolveBuildVersion(
  env: Record<string, string | undefined>,
  pkgVersion: string,
  sha: string,
  root?: string,
): string {
  const fromEnv = (env.TURNTABLE_VERSION ?? "").trim().replace(/^v/, "");
  if (fromEnv !== "") return checked(fromEnv, "TURNTABLE_VERSION");
  if (root !== undefined) {
    const file = join(root, "BUILD_VERSION");
    if (existsSync(file)) {
      const line = (readFileSync(file, "utf8").split("\n")[0] ?? "").trim().replace(/^v/, "");
      if (line !== "") return checked(line, "BUILD_VERSION file");
    }
  }
  const sha8 = sha === "unknown" ? "unknown" : sha.slice(0, 8);
  return checked(`${pkgVersion}-dev0+${sha8}`, "package.json");
}

/** The deployed commit from the BUILD_SHA file at `root` (40 hex), else "unknown". */
export function resolveBuildSha(root: string): string {
  const shaFile = join(root, "BUILD_SHA");
  const shaRaw = existsSync(shaFile) ? readFileSync(shaFile, "utf8").trim() : "";
  return /^[0-9a-f]{40}$/.test(shaRaw) ? shaRaw : "unknown";
}

/** SOURCE_DATE_EPOCH, else HEAD's committer date, else "unknown". Never the wall clock. */
export function resolveBuildTime(
  env: Record<string, string | undefined>,
  gitDate: () => string | undefined,
): string {
  const epoch = env.SOURCE_DATE_EPOCH?.trim();
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  const d = gitDate();
  if (d) {
    const t = new Date(d);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return "unknown";
}

export function gitHeadDate(root: string): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "log", "-1", "--format=%cI"], { cwd: root });
    return r.exitCode === 0 ? r.stdout.toString().trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}
