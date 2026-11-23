import { scrubbedEnv } from "@turntable/provider-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * macOS tar (bsdtar) adds AppleDouble `._*` entries for files with extended attributes (for
 * example `.git/objects/pack/._pack-*.idx`), and git in the sandbox then reports "index file ...
 * is too small". The env variable stops it on macOS, and `--no-mac-metadata` on bsdtar builds
 * that have the option.
 */
export const TAR_ENV = { COPYFILE_DISABLE: "1" } as const;

let noMeta: boolean | undefined;
/** True when this tar takes --no-mac-metadata (bsdtar does; GNU tar does not). Probed once. */
function tarHasNoMacMetadata(): boolean {
  noMeta ??= (() => {
    try {
      const p = Bun.spawnSync(
        ["tar", "--no-mac-metadata", "--no-xattrs", "-cf", "/dev/null", "-T", "/dev/null"],
        { env: scrubbedEnv(TAR_ENV), stdout: "ignore", stderr: "ignore" },
      );
      return p.exitCode === 0;
    } catch {
      return false;
    }
  })();
  return noMeta;
}

/** Arguments that keep platform metadata out of an archive, for the tar in use. */
export const tarMetadataArgs = (supported: boolean = tarHasNoMacMetadata()): string[] =>
  supported ? ["--no-mac-metadata", "--no-xattrs"] : [];

async function sh(cwd: string, argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: scrubbedEnv(TAR_ENV) });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${err.trim()}`);
  return out;
}

export interface RepoSnapshot {
  tarball: Uint8Array;
  ref: string;
  sha: string;
  /** Short branch name, undefined on a detached HEAD. */
  headBranch?: string;
  /** Subject line of HEAD. */
  commitMessage: string;
  /** `git config user.name`, else the author of HEAD. */
  actor?: string;
  /** True when the working tree has changes that are NOT in the delivered tree. */
  dirty: boolean;
}

/**
 * Packs the committed tree plus `.git`. The tree comes from `git archive HEAD`, so it is exactly
 * what CI would check out: untracked and ignored files (node_modules, build output, secrets in
 * .env) are never delivered, and uncommitted edits are not included (`dirty` reports them).
 * `.git` is appended because act's checkout stand-in copies it into the workspace.
 */
export async function snapshotRepo(repoDir: string): Promise<RepoSnapshot> {
  const sha = (await sh(repoDir, ["git", "rev-parse", "HEAD"])).trim();
  let ref = "refs/heads/main";
  try {
    ref = (await sh(repoDir, ["git", "symbolic-ref", "-q", "HEAD"])).trim() || ref;
  } catch {
    ref = sha; // detached HEAD
  }
  const headBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  const commitMessage = (await sh(repoDir, ["git", "log", "-1", "--format=%s"])).trim();
  let actor = "";
  try {
    actor = (await sh(repoDir, ["git", "config", "user.name"])).trim();
  } catch {
    // unset
  }
  if (!actor) actor = (await sh(repoDir, ["git", "log", "-1", "--format=%an"])).trim();
  const dirty =
    (await sh(repoDir, ["git", "status", "--porcelain", "--untracked-files=no"])).trim() !== "";
  const tmp = mkdtempSync(join(tmpdir(), "tt-snap-"));
  try {
    const tar = join(tmp, "repo.tar");
    await sh(repoDir, ["git", "archive", "--format=tar", "--output", tar, "HEAD"]);
    // Mode and file first: bsdtar rejects "tar --opt rf file" (it wants a mode before the old-style letters).
    await sh(repoDir, ["tar", "-r", "-f", tar, ...tarMetadataArgs(), ".git"]);
    const gz = Bun.gzipSync(new Uint8Array(await Bun.file(tar).arrayBuffer()));
    return {
      tarball: gz,
      ref,
      sha,
      commitMessage,
      ...(actor ? { actor } : {}),
      ...(headBranch ? { headBranch } : {}),
      dirty,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Files changed between `base` and HEAD, for path filters. */
export async function changedFiles(repoDir: string, base: string): Promise<string[]> {
  const out = await sh(repoDir, [
    "git",
    "-c",
    "core.quotepath=false",
    "diff",
    "--name-only",
    "--no-renames",
    base,
    "HEAD",
  ]);
  return out.split("\n").filter(Boolean);
}
