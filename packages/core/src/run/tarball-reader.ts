// Reading a run's files from the TARBALL that will be delivered, not from a directory. The
// checkout is made by a child process; if the server planned from files the child left on disk and
// ran the tarball the child wrote, a compromised child could show the planner one workflow and
// deliver another. So the server reads the tarball itself (a streaming scan: memory is bounded by
// the captured small files, and the inflate runs off the event loop) and answers `readFile` from
// that: the bytes planned are the bytes delivered. Same rules as `makeSafeReader`: a path that is
// not repository-relative, a symlink (the file or any parent), and a file over the limit are refused
// loudly, never read as missing.
import { scanTarGz } from "@turntable/act-runner";
import { assertRepoRelative, MAX_REPO_FILE_BYTES, UnsafePathError } from "./safe-read";

export interface TarballReaderOptions {
  /** Most bytes of archive content after gunzip. */
  maxUnpackedBytes: number;
  maxEntries?: number;
  /** Most bytes of file contents kept in memory for reading. Default 64 MiB. */
  captureTotal?: number;
  /** Largest file `readFile` returns. Default 1 MiB. */
  maxFileBytes?: number;
}

export async function tarballReader(
  tgz: Uint8Array,
  o: TarballReaderOptions,
): Promise<(path: string) => string | undefined> {
  const maxFile = o.maxFileBytes ?? MAX_REPO_FILE_BYTES;
  const entries = await scanTarGz(tgz, {
    maxUnpackedBytes: o.maxUnpackedBytes,
    maxEntries: o.maxEntries ?? 400_000,
    captureUpTo: maxFile,
    captureTotal: o.captureTotal ?? 64 * 1024 * 1024,
  });
  const dec = new TextDecoder();
  return (path) => {
    assertRepoRelative(path);
    // Only the canonical spelling of a path is looked up. Anything else (`a//b`, `./a`, `a/./b`,
    // `a/`, an empty name) is refused loudly rather than read as "no such file": the planner and
    // the extractor must never be asked about two spellings of one file.
    if (
      path === "" ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.split("/").some((s) => s === "" || s === "." || s === "..")
    )
      throw new UnsafePathError(path, "is not a canonical repository path");
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const parent = entries.get(parts.slice(0, i).join("/"));
      if (parent && parent.type === "symlink")
        throw new UnsafePathError(path, "resolves through a symlink");
    }
    const e = entries.get(path);
    if (!e) return undefined;
    if (e.type === "symlink") throw new UnsafePathError(path, "is a symlink");
    if (e.type !== "file") return undefined;
    if (e.size > maxFile) throw new UnsafePathError(path, `larger than ${maxFile} bytes`);
    if (e.data === undefined)
      throw new UnsafePathError(
        path,
        "is in a repository with more text than a checkout keeps for planning",
      );
    return dec.decode(e.data);
  };
}
