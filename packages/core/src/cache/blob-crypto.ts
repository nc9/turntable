// Encrypting a cache blob at rest, per org, in chunks so a byte range can be read without
// decrypting the whole file.
//
// File layout: `LSB1` | u32 header length | header (JSON) | chunks.
//  - header: { v: 1, size, chunk, key } where `key` is a random per-blob data key sealed with the
//    org's own key-encryption key (see secrets/crypto.ts, format v3: HKDF over the master key, the
//    `cache` domain and the org id). The seal's AAD names the blob id, the plaintext size and the
//    chunk size, so a header moved to another blob, or edited, does not open.
//  - chunk i (of `chunk` plaintext bytes, the last one shorter): AES-256-GCM under the data key,
//    nonce = i as a 96-bit counter (unique per data key, which is used for this blob only), AAD =
//    blob id, index and a last-chunk flag. A chunk cannot be moved, repeated or dropped from the
//    end without failing its tag.
// The blob is addressed by a numeric id, as before; the org is the one whose namespace owns the
// entry, so a blob opens only under the org that sealed it.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open as openFile, rename, rm, stat } from "node:fs/promises";
import { open, seal } from "../secrets/crypto";

const MAGIC = Buffer.from("LSB1");
export const CHUNK = 64 * 1024;
const TAG = 16;
const MAX_HEADER = 4096;

export class BlobDecryptError extends Error {
  constructor() {
    super("cache blob could not be decrypted");
  }
}

const headerAad = (id: number, size: number, chunk: number): Buffer =>
  Buffer.from(`longshore:cache-blob:${id}:${size}:${chunk}`, "utf8");

const nonce = (i: number): Buffer => {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(BigInt(i), 4);
  return b;
};

const chunkAad = (id: number, i: number, last: boolean): Buffer =>
  Buffer.from(`${id}:${i}:${last ? 1 : 0}`, "utf8");

/** How many chunks a plaintext of `size` bytes has (an empty blob has one empty chunk). */
const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / CHUNK));

/** Reads `len` bytes at `pos` from an open file, or throws if the file is shorter. */
async function readExact(
  fh: Awaited<ReturnType<typeof openFile>>,
  pos: number,
  len: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) throw new BlobDecryptError();
    got += bytesRead;
  }
  return buf;
}

/**
 * Encrypts the plaintext file `src` into `dst` (written to a temp name and renamed), for blob `id`
 * of org `orgId`. The plaintext file is left for the caller to remove.
 */
export async function encryptBlobFile(
  masterKey: Buffer,
  orgId: string,
  id: number,
  src: string,
  dst: string,
): Promise<void> {
  const size = (await stat(src)).size;
  const dek = randomBytes(32);
  const header = Buffer.from(
    JSON.stringify({
      v: 1,
      size,
      chunk: CHUNK,
      key: seal(masterKey, dek.toString("base64url"), headerAad(id, size, CHUNK), "cache", orgId),
    }),
    "utf8",
  );
  const tmp = `${dst}.tmp`;
  const input = await openFile(src, "r");
  const output = await openFile(tmp, "w", 0o600);
  try {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(header.length);
    await output.write(Buffer.concat([MAGIC, lenBuf, header]));
    const n = chunkCount(size);
    for (let i = 0; i < n; i++) {
      const want = Math.min(CHUNK, size - i * CHUNK);
      const plain = want > 0 ? await readExact(input, i * CHUNK, want) : Buffer.alloc(0);
      const c = createCipheriv("aes-256-gcm", dek, nonce(i));
      c.setAAD(chunkAad(id, i, i === n - 1));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      await output.write(Buffer.concat([ct, c.getAuthTag()]));
    }
  } catch (err) {
    await output.close();
    await input.close();
    await rm(tmp, { force: true });
    throw err;
  } finally {
    dek.fill(0);
  }
  await output.close();
  await input.close();
  await rename(tmp, dst);
}

export interface OpenBlob {
  /** Plaintext size. */
  size: number;
  /**
   * The plaintext bytes `start..end` (inclusive), decrypted and checked chunk by chunk. The blob
   * is closed when the stream ends, fails or is cancelled: one stream per open.
   */
  stream(start: number, end: number): ReadableStream<Uint8Array>;
  /** Closes without streaming (for an open that is not going to be read). */
  close(): Promise<void>;
}

/** True when the file starts with the encrypted-blob magic. */
export async function isEncryptedBlob(path: string): Promise<boolean> {
  try {
    const fh = await openFile(path, "r");
    try {
      const b = Buffer.alloc(4);
      const { bytesRead } = await fh.read(b, 0, 4, 0);
      return bytesRead === 4 && b.equals(MAGIC);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Opens an encrypted blob of org `orgId`. Throws BlobDecryptError for anything wrong: another
 * org, another id, an edited header, a short file. The first chunk is not read here; each chunk
 * is verified as it is streamed.
 */
export async function openEncryptedBlob(
  masterKey: Buffer,
  orgId: string,
  id: number,
  path: string,
): Promise<OpenBlob> {
  const fh = await openFile(path, "r");
  try {
    const fixed = await readExact(fh, 0, 8);
    if (!fixed.subarray(0, 4).equals(MAGIC)) throw new BlobDecryptError();
    const hlen = fixed.readUInt32BE(4);
    if (hlen === 0 || hlen > MAX_HEADER) throw new BlobDecryptError();
    const h = JSON.parse((await readExact(fh, 8, hlen)).toString("utf8")) as {
      v?: unknown;
      size?: unknown;
      chunk?: unknown;
      key?: unknown;
    };
    if (
      h.v !== 1 ||
      !Number.isSafeInteger(h.size) ||
      (h.size as number) < 0 ||
      h.chunk !== CHUNK ||
      typeof h.key !== "string"
    ) {
      throw new BlobDecryptError();
    }
    const size = h.size as number;
    let dek: Buffer;
    try {
      dek = Buffer.from(
        open(masterKey, h.key, headerAad(id, size, CHUNK), "cache", orgId),
        "base64url",
      );
    } catch {
      throw new BlobDecryptError();
    }
    if (dek.length !== 32) throw new BlobDecryptError();
    const n = chunkCount(size);
    const dataStart = 8 + hlen;
    const fileSize = (await fh.stat()).size;
    // Every chunk is a whole chunk plus its tag except the last: the file has exactly this length.
    const lastLen = size - (n - 1) * CHUNK;
    if (fileSize !== dataStart + (n - 1) * (CHUNK + TAG) + lastLen + TAG) {
      throw new BlobDecryptError();
    }
    const chunk = async (i: number): Promise<Buffer> => {
      const plainLen = i === n - 1 ? lastLen : CHUNK;
      const raw = await readExact(fh, dataStart + i * (CHUNK + TAG), plainLen + TAG);
      const d = createDecipheriv("aes-256-gcm", dek, nonce(i));
      d.setAAD(chunkAad(id, i, i === n - 1));
      d.setAuthTag(raw.subarray(plainLen));
      try {
        return Buffer.concat([d.update(raw.subarray(0, plainLen)), d.final()]);
      } catch {
        throw new BlobDecryptError();
      }
    };
    let closed = false;
    const closeAll = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      dek.fill(0);
      await fh.close();
    };
    return {
      size,
      stream(start, end) {
        const last = Math.min(end, size - 1);
        const first = Math.floor(start / CHUNK);
        const lastIndex = size === 0 ? 0 : Math.floor(last / CHUNK);
        let i = first;
        return new ReadableStream<Uint8Array>({
          async pull(ctl) {
            try {
              if (size === 0 || start > last || i > lastIndex) {
                await closeAll();
                return ctl.close();
              }
              const plain = await chunk(i);
              const from = i === first ? start - i * CHUNK : 0;
              const to = i === lastIndex ? last - i * CHUNK + 1 : plain.length;
              ctl.enqueue(new Uint8Array(plain.subarray(from, to)));
              i++;
              if (i > lastIndex) {
                await closeAll();
                ctl.close();
              }
            } catch (err) {
              await closeAll();
              ctl.error(err);
            }
          },
          async cancel() {
            await closeAll();
          },
        });
      },
      close: closeAll,
    };
  } catch (err) {
    await fh.close();
    throw err instanceof BlobDecryptError ? err : new BlobDecryptError();
  }
}
