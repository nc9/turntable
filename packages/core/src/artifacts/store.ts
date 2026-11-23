// Where artifact bytes live: `<dir>/<run id>/<name>`, the layout the release lane reads
// (release/artifacts.ts, the lane's artifact directory). Uploads are staged under
// `<dir>/.staging/<upload id>` and only renamed into place once the service has hashed them and
// recorded the artifact, so a name in the served tree is always complete bytes the control plane
// itself wrote and hashed. The directory is 0700 and written only by this process.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export class ArtifactTooLargeError extends Error {}

/** Names the store will hold: one plain path component, so a name can never be a directory. */
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const RUN_ID = /^[0-9A-Za-z]{1,64}$/;
const UPLOAD_ID = /^[0-9a-f]{32}$/;

export type Staged = { size: number; sha256: string };

export class FsArtifactStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }
  get dir(): string {
    return this.#dir;
  }
  #staging(uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) throw new Error("bad upload id");
    return join(this.#dir, ".staging", uploadId);
  }
  #final(runId: string, name: string): string {
    if (!RUN_ID.test(runId) || !ARTIFACT_NAME.test(name)) throw new Error("bad artifact path");
    return join(this.#dir, runId, name);
  }
  #blockFile(uploadId: string, blockId: string): string {
    return join(this.#staging(uploadId), `block-${Buffer.from(blockId).toString("hex")}`);
  }

  /** Streams one block into staging, refusing past `max` bytes. Returns the bytes written. */
  async stageBlock(
    uploadId: string,
    blockId: string,
    body: ReadableStream<Uint8Array> | null,
    max: number,
  ): Promise<number> {
    await mkdir(this.#staging(uploadId), { recursive: true, mode: 0o700 });
    return this.#write(this.#blockFile(uploadId, blockId), body, max);
  }

  /** Stages a whole blob (the single-request upload) and hashes it. */
  async stageBlob(
    uploadId: string,
    body: ReadableStream<Uint8Array> | null,
    max: number,
  ): Promise<Staged> {
    await mkdir(this.#staging(uploadId), { recursive: true, mode: 0o700 });
    const file = join(this.#staging(uploadId), "blob");
    await this.#write(file, body, max);
    return hashFile(file);
  }

  /** Concatenates the staged blocks in the order given into the staged blob, and hashes it. */
  async assemble(uploadId: string, blockIds: readonly string[], max: number): Promise<Staged> {
    const out = join(this.#staging(uploadId), "blob");
    const fh = await open(out, "w", 0o600);
    const h = createHash("sha256");
    let size = 0;
    try {
      for (const id of blockIds) {
        for await (const chunk of createReadStream(this.#blockFile(uploadId, id))) {
          const buf = chunk as Buffer;
          size += buf.length;
          if (size > max) throw new ArtifactTooLargeError("artifact is too large");
          h.update(buf);
          await fh.write(buf);
        }
      }
    } catch (err) {
      await fh.close();
      await rm(out, { force: true });
      throw err;
    }
    await fh.close();
    return { size, sha256: h.digest("hex") };
  }

  /** The staged blob's size and digest, recomputed from the file; null when there is none. */
  async staged(uploadId: string): Promise<Staged | null> {
    try {
      return await hashFile(join(this.#staging(uploadId), "blob"));
    } catch {
      return null;
    }
  }

  /** Moves the staged blob to its served place and drops the rest of the staging area. */
  async promote(uploadId: string, runId: string, name: string): Promise<void> {
    const dest = this.#final(runId, name);
    await mkdir(join(this.#dir, runId), { recursive: true, mode: 0o700 });
    await rename(join(this.#staging(uploadId), "blob"), dest);
    await this.discard(uploadId);
  }

  async discard(uploadId: string): Promise<void> {
    await rm(this.#staging(uploadId), { recursive: true, force: true });
  }

  /**
   * The served blob, hashed from the file on this read; null when it is not there. The caller
   * compares the digest with the recorded one before it serves a byte.
   */
  async open(runId: string, name: string): Promise<(Staged & { file: Blob }) | null> {
    const path = this.#final(runId, name);
    try {
      const st = await stat(path);
      if (!st.isFile()) return null;
      const h = await hashFile(path);
      return { ...h, file: Bun.file(path) };
    } catch {
      return null;
    }
  }

  /** Removes served blobs written before `cutoff` (ms), and abandoned staging areas. */
  async sweep(cutoff: number, stagingCutoff: number): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.#dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const base = join(this.#dir, e.name);
      const stale = e.name === ".staging" ? stagingCutoff : cutoff;
      for (const f of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        const p = join(base, f.name);
        const st = await stat(p).catch(() => null);
        if (!st || st.mtimeMs >= stale) continue;
        await rm(p, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  async #write(
    file: string,
    body: ReadableStream<Uint8Array> | null,
    max: number,
  ): Promise<number> {
    const fh = await open(file, "w", 0o600);
    let size = 0;
    try {
      if (body) {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > max) throw new ArtifactTooLargeError("upload is larger than allowed");
          await fh.write(chunk);
        }
      }
    } catch (err) {
      await fh.close();
      await rm(file, { force: true });
      throw err;
    }
    await fh.close();
    return size;
  }
}

async function hashFile(path: string): Promise<Staged> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: h.digest("hex") };
}
