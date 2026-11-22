// Artifact bytes, read-only, from a directory laid out `<dir>/<run id>/<name>`. The release lane
// recomputes digests from these bytes itself.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface ArtifactBytes {
  read(runId: string, name: string): Promise<Uint8Array | undefined>;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;

export function dirArtifacts(dir: string): ArtifactBytes {
  const root = resolve(dir);
  return {
    async read(runId, name) {
      if (!/^[0-9A-Za-z]+$/.test(runId) || !SAFE.test(name) || name.split("/").includes(".."))
        return undefined;
      const p = resolve(join(root, runId, name));
      if (!p.startsWith(root + sep)) return undefined;
      if (!existsSync(p) || !statSync(p).isFile()) return undefined;
      return new Uint8Array(readFileSync(p));
    },
  };
}
