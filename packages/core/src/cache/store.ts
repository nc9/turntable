// Where cache blobs live. The service never touches the file system directly: it goes through
// this interface, so another backend (S3, a volume) can replace the directory store later. A blob
// is addressed by the numeric entry id only; the namespace logic is above this layer.
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { encryptBlobFile, isEncryptedBlob, openEncryptedBlob } from "./blob-crypto";

export interface CacheBlobStore {
  /** Writes `bytes` at `offset` into the entry's STAGING blob (never the served one). */
  write(id: number, offset: number, bytes: Uint8Array): Promise<void>;
  /** Size of the staging blob; null when there is none. */
  stagedSize(id: number): Promise<number | null>;
  /** A local file path of the staging blob, for validation. A remote store would download it. */
  stagedPath(id: number): Promise<string | null>;
  /** Where the canonical re-emission of the staging blob is written (a local path). */
  scratchPath(id: number): Promise<string>;
  scratchSize(id: number): Promise<number | null>;
  /**
   * Atomically turns the canonical scratch blob into the served one and drops the staging blob.
   * What is served is only ever bytes we wrote, from a file no client can write, and the staging
   * file is gone afterwards, so a write after commit has nothing to land in.
   */
  promote(id: number, orgId: string): Promise<void>;
  /**
   * The served blob (or a byte range of it, in plaintext offsets) as a response body; null when
   * not promoted. `orgId` is the org whose namespace owns the entry: an encrypting store opens
   * the blob only with that org's key.
   */
  read(id: number, orgId: string, range?: { start: number; end: number }): Promise<Response | null>;
  /** Ids that have a file of any kind in the store, for the orphan sweep. */
  listIds(): Promise<number[]>;
  /** Removes both the staging and the served blob. */
  delete(id: number): Promise<void>;
}

/**
 * Blobs in a directory. With a master key, a promoted blob is stored encrypted under its org's own
 * key, in chunks (see blob-crypto.ts), so a copy of the directory holds no cache contents and a
 * blob read under another org fails. The staging and scratch files (an upload in flight, and the
 * canonical archive on its way to `promote`) are plaintext, briefly, in a 0700 directory: the
 * service has to parse them. Both are removed at promote, and by the orphan sweep if a process
 * died between. Without a key the store is as before; a store with a key serves no unencrypted
 * blob (a miss, so the entry is rebuilt).
 */
export class FsCacheStore implements CacheBlobStore {
  readonly #dir: string;
  readonly #key: Buffer | undefined;
  constructor(dir: string, opts: { masterKey?: Buffer | undefined } = {}) {
    this.#dir = dir;
    this.#key = opts.masterKey;
  }
  /** True when promoted blobs are encrypted. */
  get encrypting(): boolean {
    return this.#key !== undefined;
  }
  #id(id: number): void {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("bad cache id");
  }
  #blob(id: number): string {
    this.#id(id);
    return join(this.#dir, `${id}.blob`);
  }
  #canon(id: number): string {
    this.#id(id);
    return join(this.#dir, `${id}.canon`);
  }
  #part(id: number): string {
    this.#id(id);
    return join(this.#dir, `${id}.part`);
  }
  async write(id: number, offset: number, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    // Not append mode: positional writes are ignored there on Linux.
    const fh = await open(this.#part(id), constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      await fh.write(bytes, 0, bytes.length, offset);
    } finally {
      await fh.close();
    }
  }
  async #size(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  }
  stagedSize(id: number): Promise<number | null> {
    return this.#size(this.#part(id));
  }
  async stagedPath(id: number): Promise<string | null> {
    return (await this.stagedSize(id)) === null ? null : this.#part(id);
  }
  async scratchPath(id: number): Promise<string> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    return this.#canon(id);
  }
  scratchSize(id: number): Promise<number | null> {
    return this.#size(this.#canon(id));
  }
  async promote(id: number, orgId: string): Promise<void> {
    if (this.#key) {
      await encryptBlobFile(this.#key, orgId, id, this.#canon(id), this.#blob(id));
      await rm(this.#canon(id), { force: true });
    } else {
      await rename(this.#canon(id), this.#blob(id));
    }
    await rm(this.#part(id), { force: true });
  }
  async read(
    id: number,
    orgId: string,
    range?: { start: number; end: number },
  ): Promise<Response | null> {
    const size = await this.#size(this.#blob(id));
    if (size === null) return null;
    if (this.#key) return this.#readEncrypted(this.#key, id, orgId, range);
    const file = Bun.file(this.#blob(id));
    if (!range) return new Response(file, { headers: { "content-length": String(size) } });
    const end = Math.min(range.end, size - 1);
    return new Response(file.slice(range.start, end + 1), {
      status: 206,
      headers: {
        "content-range": `bytes ${range.start}-${end}/${size}`,
        "content-length": String(end - range.start + 1),
      },
    });
  }
  async #readEncrypted(
    key: Buffer,
    id: number,
    orgId: string,
    range: { start: number; end: number } | undefined,
  ): Promise<Response | null> {
    // A blob that is not in the encrypted format is not served: it is a miss.
    if (!(await isEncryptedBlob(this.#blob(id)))) return null;
    let blob;
    try {
      blob = await openEncryptedBlob(key, orgId, id, this.#blob(id));
    } catch {
      return new Response("blob unreadable", { status: 500 });
    }
    if (!range) {
      return new Response(blob.stream(0, Math.max(0, blob.size - 1)), {
        headers: { "content-length": String(blob.size) },
      });
    }
    if (blob.size === 0 || range.start >= blob.size || range.end < range.start) {
      await blob.close();
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${blob.size}` },
      });
    }
    const end = Math.min(range.end, blob.size - 1);
    return new Response(blob.stream(range.start, end), {
      status: 206,
      headers: {
        "content-range": `bytes ${range.start}-${end}/${blob.size}`,
        "content-length": String(end - range.start + 1),
      },
    });
  }
  async listIds(): Promise<number[]> {
    try {
      const ids = new Set<number>();
      for (const f of await readdir(this.#dir)) {
        const m = /^(\d{1,15})\.(blob|part|canon)$/.exec(f);
        if (m) ids.add(Number(m[1]));
      }
      return [...ids];
    } catch {
      return [];
    }
  }
  async delete(id: number): Promise<void> {
    await rm(this.#part(id), { force: true });
    await rm(this.#canon(id), { force: true });
    await rm(this.#blob(id), { force: true });
  }
}
