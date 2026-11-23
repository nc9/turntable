import { tarGzDirectory, type WalkHooks } from "./tar";

/** Packs a directory (including .git) into a gzip tarball, in process: no `tar` binary is run. */
export async function tarDirectory(
  dir: string,
  entries: string[] = ["."],
  hooks?: WalkHooks,
): Promise<Uint8Array> {
  return tarGzDirectory(dir, entries, hooks);
}
