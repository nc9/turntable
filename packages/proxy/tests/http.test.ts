import { describe, expect, test } from "bun:test";
import { RequestReader } from "../src/http";

const head = (extra = "") => `POST /v1/a HTTP/1.1\r\nHost: h.example.test\r\n${extra}\r\n`;
const read = (text: string, limits?: { headerBytes: number; bodyBytes: number }) => {
  const r = new RequestReader(limits);
  r.feed(Buffer.from(text, "latin1"));
  return r.next();
};

describe("request framing limits", () => {
  test("a chunk trailer line with no end is refused once it is too long, not waited for", () => {
    const res = read(`${head("transfer-encoding: chunked\r\n")}0\r\n${"x".repeat(9000)}`);
    expect(res).toEqual({ kind: "error", reason: "bad_trailer" });
  });

  test("a short unfinished trailer line still waits for more", () => {
    expect(read(`${head("transfer-encoding: chunked\r\n")}0\r\nx-a: b`)).toEqual({
      kind: "need_more",
    });
  });

  test("trailers are bounded in length per line and in total", () => {
    const one = `${"y".repeat(9000)}\r\n`;
    expect(read(`${head("transfer-encoding: chunked\r\n")}0\r\n${one}\r\n`)).toEqual({
      kind: "error",
      reason: "bad_trailer",
    });
    const many = Array.from({ length: 400 }, (_, i) => `x-${i}: ${"v".repeat(60)}\r\n`).join("");
    expect(read(`${head("transfer-encoding: chunked\r\n")}0\r\n${many}\r\n`)).toEqual({
      kind: "error",
      reason: "bad_trailer",
    });
  });

  test("a chunk-size line with no end is refused once it is too long", () => {
    expect(read(`${head("transfer-encoding: chunked\r\n")}${"f".repeat(2000)}`)).toEqual({
      kind: "error",
      reason: "bad_chunk",
    });
  });

  test("what is buffered stays within one request's worth of bytes", () => {
    const r = new RequestReader({ headerBytes: 1024, bodyBytes: 1024 });
    // A body that never completes, fed in pieces.
    r.feed(Buffer.from(head("content-length: 1000\r\n"), "latin1"));
    for (let i = 0; i < 100; i++) r.feed(Buffer.alloc(4096, 0x61));
    expect(r.next()).toEqual({ kind: "error", reason: "buffer_too_large" });
  });

  test("an ordinary chunked request with a small trailer is read", () => {
    const res = read(`${head("transfer-encoding: chunked\r\n")}3\r\nabc\r\n0\r\nx-sum: 1\r\n\r\n`);
    expect(res.kind).toBe("request");
    if (res.kind === "request") expect(res.request.body.toString()).toBe("abc");
  });
});
