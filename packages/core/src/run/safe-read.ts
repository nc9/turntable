// The one way the host reads files out of a checked-out repository. A repo is untrusted content:
// a workflow can say `uses: ./../../etc/x`, and a committed symlink can point at any host file
// (the poller's token file, an ssh key). Everything that reads repo files on the host (the
// scheduler worker, the CLI, the planner's local-action scan) goes through `makeSafeReader`.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/** Largest repo file the host will read (workflows and action.yml are tiny). */
export const MAX_REPO_FILE_BYTES = 1024 * 1024;

export class UnsafePathError extends Error {
  readonly path: string;
  constructor(path: string, why: string) {
    super(`refusing to read ${JSON.stringify(path)} from the repository: ${why}`);
    this.path = path;
  }
}

/**
 * Checks a repo-relative path before it is joined to anything: not absolute, no NUL, no backslash,
 * no `..` segment (even one that would stay inside: there is no reason for it).
 */
export function assertRepoRelative(path: string): void {
  if (path === "" || path.includes("\0"))
    throw new UnsafePathError(path, "empty or has a NUL byte");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    throw new UnsafePathError(path, "absolute path");
  if (path.includes("\\")) throw new UnsafePathError(path, "backslash in path");
  if (path.split("/").includes("..")) throw new UnsafePathError(path, "`..` segment");
}

/**
 * Returns a reader for files under `dir`. For each read:
 *
 * 1. the path must be repo-relative with no `..` segment (see assertRepoRelative);
 * 2. the file itself must not be a symlink, whatever it points at (opened with O_NOFOLLOW, so
 *    there is no check-then-use race on the last component): a committed symlink named
 *    action.yml is never followed, even to a file inside the checkout;
 * 3. the real path of the file (symlinked parent directories resolved) must stay inside the
 *    real path of `dir`, so a symlinked directory cannot lead out either (a symlinked
 *    directory that stays inside the checkout is fine);
 * 4. it must be a regular file of at most `maxBytes` (default 1 MiB).
 *
 * A file that does not exist reads as `undefined`. Anything unsafe throws UnsafePathError, loudly:
 * a refused read must never look like a missing file.
 */
export function makeSafeReader(
  dir: string,
  opts: { maxBytes?: number } = {},
): (path: string) => string | undefined {
  const max = opts.maxBytes ?? MAX_REPO_FILE_BYTES;
  return (path) => {
    assertRepoRelative(path);
    const root = realpathSync(dir);
    const full = join(root, path);
    let fd: number;
    try {
      fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      // O_NOFOLLOW on a symlink fails with ELOOP (Linux, macOS) or EMLINK (some BSDs).
      if (code === "ELOOP" || code === "EMLINK") throw new UnsafePathError(path, "is a symlink");
      throw err;
    }
    try {
      const real = realpathSync(full);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new UnsafePathError(path, "resolves outside the checkout");
      }
      const st = fstatSync(fd);
      if (!st.isFile()) return undefined;
      if (st.size > max) throw new UnsafePathError(path, `larger than ${max} bytes`);
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      return buf.subarray(0, off).toString("utf8");
    } finally {
      closeSync(fd);
    }
  };
}
