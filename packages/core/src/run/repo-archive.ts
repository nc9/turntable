import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function sh(cwd: string, argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
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
  const dirty =
    (await sh(repoDir, ["git", "status", "--porcelain", "--untracked-files=no"])).trim() !== "";
  const tmp = mkdtempSync(join(tmpdir(), "tt-snap-"));
  try {
    const tar = join(tmp, "repo.tar");
    await sh(repoDir, ["git", "archive", "--format=tar", "--output", tar, "HEAD"]);
    await sh(repoDir, ["tar", "rf", tar, ".git"]);
    const gz = Bun.gzipSync(new Uint8Array(await Bun.file(tar).arrayBuffer()));
    return { tarball: gz, ref, sha, dirty };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
