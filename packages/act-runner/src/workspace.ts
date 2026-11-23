import { tarGzDirectory } from "./tar";

/** Packs a directory (including .git) into a gzip tarball, in process: no `tar` binary is run. */
export async function tarDirectory(dir: string, entries: string[] = ["."]): Promise<Uint8Array> {
  return tarGzDirectory(dir, entries);
}
