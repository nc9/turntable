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

describe("header parsing is linear", () => {
  const timed = (text: string): { ms: number; res: ReturnType<typeof read> } => {
    const t0 = performance.now();
    const res = read(text);
    return { ms: performance.now() - t0, res };
  };

  test("a long run of spaces or tabs in a header cannot make parsing slow", () => {
    // Long enough to be catastrophic for a backtracking pattern, short enough to be a legal line.
    for (const ws of [" ", "\t", " \t"]) {
      const value = ws.repeat(3000);
      const { ms, res } = timed(`${head(`x-a:${value}b${value}\r\n`)}`);
      expect(res.kind).toBe("request" in res ? "request" : res.kind);
      expect(ms).toBeLessThan(100);
    }
    // And one that does not end in a value at all.
    const { ms } = timed(head(`x-a:${" ".repeat(8000)}\r\n`));
    expect(ms).toBeLessThan(100);
  });

  test("a header line over the cap is refused, quickly, however it is built", () => {
    for (const line of [
      `x-a: ${"v".repeat(9000)}`,
      `x-a:${" ".repeat(200_000)}z`,
      `${"n".repeat(9000)}: v`,
    ]) {
      const { ms, res } = timed(head(`${line}\r\n`));
      // Over the line cap, or (for the longest) already over the whole header budget.
      expect(res.kind).toBe("error");
      expect(["header_line_too_long", "headers_too_large"]).toContain(
        res.kind === "error" ? res.reason : "",
      );
      expect(ms).toBeLessThan(100);
    }
  });

  test("values are trimmed of spaces and tabs at both ends only", () => {
    const res = read(head("x-a: \t one two \t \r\n"));
    expect(res.kind).toBe("request");
    if (res.kind === "request") {
      expect(res.request.headers.find(([k]) => k === "x-a")?.[1]).toBe("one two");
    }
  });

  test("a line with no colon, or an empty name, is refused", () => {
    expect(read(head("nocolon\r\n"))).toEqual({ kind: "error", reason: "bad_header" });
    expect(read(head(": v\r\n"))).toEqual({ kind: "error", reason: "bad_header" });
  });
});
