// Artifact bytes, read-only, from a directory laid out `<dir>/<run id>/<name>`. The release lane
// recomputes digests from these bytes itself, so what it reads must be exactly the file at that
// path inside the directory, never something a link points at.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";

export interface ArtifactBytes {
  read(runId: string, name: string): Promise<Uint8Array | undefined>;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;

export function dirArtifacts(dir: string): ArtifactBytes {
  return {
    async read(runId, name) {
      if (!/^[0-9A-Za-z]+$/.test(runId) || !SAFE.test(name) || name.split("/").includes("..")) {
        return undefined;
      }
      let root: string;
      try {
        root = realpathSync(dir);
      } catch {
        return undefined;
      }
      // Every component under the root must be a real directory, and the last a regular file:
      // a symlink anywhere, even one that stays inside the directory, is refused.
      let p = root;
      const parts = [runId, ...name.split("/")];
      for (const [i, part] of parts.entries()) {
        p = join(p, part);
        let st;
        try {
          st = lstatSync(p);
        } catch {
          return undefined;
        }
        if (st.isSymbolicLink()) return undefined;
        if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return undefined;
      }
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        return undefined;
      }
      if (!real.startsWith(root + sep)) return undefined;
      // Open without following a final link, and read from the descriptor that was checked.
      let fd: number;
      try {
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return undefined;
      }
      try {
        if (!fstatSync(fd).isFile()) return undefined;
        return new Uint8Array(readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    },
  };
}
