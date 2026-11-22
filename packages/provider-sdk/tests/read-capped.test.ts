import { describe, expect, test } from "bun:test";
import { FileTooLargeError } from "../src/errors";
import { readCapped, readCappedJson, readCappedText } from "../src/read-capped";

/** A body that produces `n` chunks of `size` bytes and records whether the reader cancelled it. */
function endless(chunks: number, size: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close();
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { headers }), state };
}

describe("readCapped", () => {
  test("returns a body at or under the cap, including exactly at the cap and empty", async () => {
    expect(new TextDecoder().decode(await readCapped(new Response("hello"), 5))).toBe("hello");
    expect((await readCapped(new Response("hello"), 100)).length).toBe(5);
    expect((await readCapped(new Response(null), 10)).length).toBe(0);
    expect((await readCapped(new Response(""), 0)).length).toBe(0);
  });

  test("stops reading and cancels the stream once the cap is passed, without content-length", async () => {
    const { res, state } = endless(1000, 1024); // 1 MiB offered, 4 KiB allowed
    await expect(readCapped(res, 4096)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(50); // nowhere near the full 1000 chunks
  });

  test("a content-length that lies low cannot smuggle a bigger body", async () => {
    const { res, state } = endless(100, 1024, { "content-length": "10" });
    await expect(readCapped(res, 4096)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(state.cancelled).toBe(true);
  });

  test("a declared length over the cap is refused before any byte is read", async () => {
    const { res, state } = endless(100, 1024, { "content-length": "999999999" });
    await expect(readCapped(res, 4096)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  test("a missing or malformed content-length is treated as unknown, not as zero", async () => {
    const big = new Response("x".repeat(200));
    expect(big.headers.get("content-length")).toBeNull();
    await expect(readCapped(big, 100)).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(
      readCapped(new Response("x".repeat(200), { headers: { "content-length": "abc" } }), 100),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  test("many small chunks add up to the cap exactly", async () => {
    const { res } = endless(10, 100); // 1000 bytes
    expect((await readCapped(res, 1000)).length).toBe(1000);
    const over = endless(10, 100);
    await expect(readCapped(over.res, 999)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  test("text and json helpers apply the same cap", async () => {
    expect(await readCappedText(new Response("héllo"), 100)).toBe("héllo");
    expect(await readCappedJson<{ a: number }>(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
    await expect(
      readCappedJson(new Response(`{"a":"${"x".repeat(500)}"}`), 100),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });

  test("rejects a nonsense cap", async () => {
    await expect(readCapped(new Response("x"), -1)).rejects.toBeInstanceOf(RangeError);
    await expect(readCapped(new Response("x"), 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});
