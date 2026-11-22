import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK } from "../src/cache/blob-crypto";
import { FsCacheStore } from "../src/cache/store";

const MASTER = randomBytes(32);
let dir: string;
let store: FsCacheStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-blob-"));
  store = new FsCacheStore(dir, { masterKey: MASTER });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const marker = (n: number): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  if (n >= 24) b.write("PLAINTEXT-MARKER-0123", 3);
  return b;
};

/** Stages `bytes` as blob `id` the way the service does, then promotes it for `org`. */
async function put(id: number, org: string, bytes: Buffer, s: FsCacheStore = store): Promise<void> {
  await s.write(id, 0, bytes);
  writeFileSync(await s.scratchPath(id), bytes);
  await s.promote(id, org);
}
const bodyOf = async (r: Response | null): Promise<Buffer> => Buffer.from(await r!.arrayBuffer());

describe("encrypted at rest, per org", () => {
  test("round trips every size around the chunk boundaries, and nothing on disk is plaintext", async () => {
    const sizes = [0, 1, 15, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 17];
    for (const [i, n] of sizes.entries()) {
      const bytes = marker(n);
      await put(100 + i, "org-a", bytes);
      const res = await store.read(100 + i, "org-a");
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-length")).toBe(String(n));
      expect((await bodyOf(res)).equals(bytes)).toBe(true);
      if (n >= 24)
        expect(readFileSync(join(dir, `${100 + i}.blob`)).includes("PLAINTEXT-MARKER")).toBe(false);
    }
    // no staging or scratch file is left once promoted
    expect(
      readdirSync(dir)
        .filter((f) => !f.endsWith(".blob"))
        .toSorted(),
    ).toEqual([]);
  });

  test("range reads equal the plaintext slice, across chunk boundaries, and clamp at the end", async () => {
    const bytes = marker(3 * CHUNK + 1234);
    await put(1, "org-a", bytes);
    const cases: [number, number][] = [
      [0, 0],
      [0, 9],
      [CHUNK - 3, CHUNK + 3],
      [CHUNK, CHUNK],
      [CHUNK, 2 * CHUNK - 1],
      [5, 3 * CHUNK + 1233],
      [3 * CHUNK, 3 * CHUNK + 1233],
      [3 * CHUNK + 1233, 3 * CHUNK + 1233],
      [100, Number.MAX_SAFE_INTEGER],
    ];
    for (let k = 0; k < 20; k++) {
      const a = Math.floor(Math.random() * bytes.length);
      cases.push([a, a + Math.floor(Math.random() * 3 * CHUNK)]);
    }
    for (const [start, end] of cases) {
      const res = await store.read(1, "org-a", { start, end });
      const last = Math.min(end, bytes.length - 1);
      expect(res!.status).toBe(206);
      expect(res!.headers.get("content-range")).toBe(`bytes ${start}-${last}/${bytes.length}`);
      expect((await bodyOf(res)).equals(bytes.subarray(start, last + 1))).toBe(true);
    }
    // outside the blob, or backwards: unsatisfiable, never a partial leak
    for (const range of [
      { start: bytes.length, end: bytes.length + 5 },
      { start: 9, end: 3 },
    ]) {
      expect((await store.read(1, "org-a", range))!.status).toBe(416);
    }
  });

  test("another org's key does not open it, and neither does another blob id", async () => {
    await put(7, "org-a", marker(CHUNK + 5));
    expect((await store.read(7, "org-b"))!.status).toBe(500);
    // the same bytes copied to another id (a blob moved within the directory)
    copyFileSync(join(dir, "7.blob"), join(dir, "8.blob"));
    expect((await store.read(8, "org-a"))!.status).toBe(500);
    // a different master key
    const other = new FsCacheStore(dir, { masterKey: randomBytes(32) });
    expect((await other.read(7, "org-a"))!.status).toBe(500);
    expect((await bodyOf(await store.read(7, "org-a"))).length).toBe(CHUNK + 5);
  });

  test("a changed, reordered, truncated or extended file fails closed", async () => {
    const bytes = marker(3 * CHUNK + 50);
    await put(1, "org-a", bytes);
    const good = readFileSync(join(dir, "1.blob"));
    const headerLen = 8 + good.readUInt32BE(4);
    const unit = CHUNK + 16;
    const attempt = async (tampered: Buffer): Promise<"unreadable" | "stream-error" | "ok"> => {
      writeFileSync(join(dir, "1.blob"), tampered);
      const res = await store.read(1, "org-a");
      if (res!.status === 500) return "unreadable";
      try {
        await res!.arrayBuffer();
        return "ok";
      } catch {
        return "stream-error";
      }
    };
    // a flipped bit in a chunk
    const flipped = Buffer.from(good);
    flipped[headerLen + 10] = (flipped[headerLen + 10] ?? 0) ^ 1;
    expect(await attempt(flipped)).toBe("stream-error");
    // two chunks swapped
    const swapped = Buffer.from(good);
    good.copy(swapped, headerLen, headerLen + unit, headerLen + 2 * unit);
    good.copy(swapped, headerLen + unit, headerLen, headerLen + unit);
    expect(await attempt(swapped)).toBe("stream-error");
    // the last chunk dropped, or bytes added, or the file cut mid-chunk: the length is checked first
    expect(await attempt(good.subarray(0, good.length - 50 - 16))).toBe("unreadable");
    expect(await attempt(Buffer.concat([good, Buffer.from([0])]))).toBe("unreadable");
    expect(await attempt(good.subarray(0, headerLen + 100))).toBe("unreadable");
    // an edited header (size) does not open
    const hdr = JSON.parse(good.subarray(8, headerLen).toString("utf8")) as { size: number };
    const edited = Buffer.from(JSON.stringify({ ...hdr, size: hdr.size - 1 }));
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(edited.length);
    expect(
      await attempt(Buffer.concat([good.subarray(0, 4), lenBuf, edited, good.subarray(headerLen)])),
    ).toBe("unreadable");
    // the original still works
    expect(await attempt(good)).toBe("ok");
  });

  test("a plaintext blob in an encrypting store is a miss, not served", async () => {
    writeFileSync(join(dir, "5.blob"), "plain bytes someone left here");
    expect(await store.read(5, "org-a")).toBeNull();
    expect(await store.read(404, "org-a")).toBeNull();
  });

  test("without a key the store is as it was: plain blobs, ranges, no encryption", async () => {
    const plain = new FsCacheStore(dir);
    const bytes = marker(CHUNK + 100);
    await put(9, "org-a", bytes, plain);
    expect(readFileSync(join(dir, "9.blob")).equals(bytes)).toBe(true);
    expect((await bodyOf(await plain.read(9, "org-a"))).equals(bytes)).toBe(true);
    const r = await plain.read(9, "org-a", { start: 10, end: 20 });
    expect((await bodyOf(r)).equals(bytes.subarray(10, 21))).toBe(true);
    // and a store with a key refuses what a keyless one wrote
    expect(await store.read(9, "org-a")).toBeNull();
  });

  test("delete removes the encrypted blob, and the orphan listing sees it", async () => {
    await put(3, "org-a", marker(10));
    expect(await store.listIds()).toContain(3);
    await store.delete(3);
    expect(await store.read(3, "org-a")).toBeNull();
    expect(await store.listIds()).not.toContain(3);
  });
});
