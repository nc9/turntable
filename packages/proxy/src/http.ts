// A strict HTTP/1.1 request reader for the decrypted side of a tunnel. It accepts only what it
// can frame without ambiguity and says why when it refuses; it never guesses.
export interface Limits {
  headerBytes: number;
  bodyBytes: number;
}

export const DEFAULT_LIMITS: Limits = { headerBytes: 32 * 1024, bodyBytes: 32 * 1024 * 1024 };

export interface ParsedRequest {
  method: string;
  target: string;
  /** Lower-case names, in order. */
  headers: [string, string][];
  body: Buffer;
  /** The client asked to close after this request. */
  close: boolean;
}

export type ReadResult =
  | { kind: "request"; request: ParsedRequest }
  | { kind: "need_more" }
  /** The client sent `Expect: 100-continue`: answer with 100 Continue, then read again. */
  | { kind: "continue" }
  | { kind: "error"; reason: string };

interface Head {
  method: string;
  target: string;
  headers: [string, string][];
  length: number | "chunked";
  close: boolean;
  expect: boolean;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The head of a request (request line and headers), or the reason it is refused. */
export function parseHead(text: string): Head | string {
  const lines = text.split("\r\n");
  const m = /^([A-Z]{3,10}) (\S+) HTTP\/1\.1$/.exec(lines[0] ?? "");
  if (!m) return "bad_request_line";
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) return "obs_fold";
    const h = /^([^:]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!h || !TOKEN.test(h[1]!)) return "bad_header";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000\r\n]/.test(h[2]!)) return "bad_header_value";
    headers.push([h[1]!.toLowerCase(), h[2]!]);
  }
  const all = (n: string): string[] => headers.filter(([k]) => k === n).map(([, v]) => v);
  if (all("host").length !== 1) return "host_header_count";
  if (all("upgrade").length > 0) return "upgrade_refused";
  const cl = all("content-length");
  const te = all("transfer-encoding");
  if (cl.length > 0 && te.length > 0) return "content_length_and_transfer_encoding";
  if (cl.length > 1) return "duplicate_content_length";
  let length: number | "chunked" = 0;
  if (te.length > 0) {
    if (te.length > 1 || te[0]!.toLowerCase() !== "chunked") return "unsupported_transfer_encoding";
    length = "chunked";
  } else if (cl.length === 1) {
    if (!/^\d{1,12}$/.test(cl[0]!)) return "bad_content_length";
    length = Number(cl[0]);
  }
  const connection = all("connection").join(",").toLowerCase();
  const expectValues = all("expect");
  if (
    expectValues.length > 0 &&
    !(expectValues.length === 1 && expectValues[0]!.toLowerCase() === "100-continue")
  ) {
    return "unsupported_expect";
  }
  return {
    method: m[1]!,
    target: m[2]!,
    headers,
    length,
    close: /(^|,)\s*close\s*(,|$)/.test(connection),
    expect: expectValues.length === 1,
  };
}

function readChunked(
  buf: Buffer,
  max: number,
): "need_more" | string | { body: Buffer; consumed: number } {
  const parts: Buffer[] = [];
  let pos = 0;
  let total = 0;
  for (;;) {
    const eol = buf.indexOf("\r\n", pos);
    if (eol < 0) return buf.length - pos > 1024 ? "bad_chunk" : "need_more";
    const sizeText = buf.subarray(pos, eol).toString("latin1").split(";", 1)[0]!.trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) return "bad_chunk";
    const size = Number.parseInt(sizeText, 16);
    pos = eol + 2;
    if (size === 0) {
      // Trailers are read and dropped, up to the terminating empty line.
      for (;;) {
        const e = buf.indexOf("\r\n", pos);
        if (e < 0) return "need_more";
        const line = buf.subarray(pos, e).length;
        pos = e + 2;
        if (line === 0) return { body: Buffer.concat(parts), consumed: pos };
        if (pos > buf.length || e - pos > 8192) return "bad_chunk";
      }
    }
    total += size;
    if (total > max) return "body_too_large";
    if (buf.length < pos + size + 2) return "need_more";
    parts.push(buf.subarray(pos, pos + size));
    if (buf.subarray(pos + size, pos + size + 2).toString("latin1") !== "\r\n") return "bad_chunk";
    pos += size + 2;
  }
}

export class RequestReader {
  #buf: Buffer = Buffer.alloc(0);
  readonly #limits: Limits;
  #head: (Head & { continued: boolean }) | undefined;

  constructor(limits: Limits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  feed(chunk: Buffer): void {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
  }

  next(): ReadResult {
    if (!this.#head) {
      const end = this.#buf.indexOf("\r\n\r\n");
      if (end < 0) {
        return this.#buf.length > this.#limits.headerBytes
          ? { kind: "error", reason: "headers_too_large" }
          : { kind: "need_more" };
      }
      if (end > this.#limits.headerBytes) return { kind: "error", reason: "headers_too_large" };
      const parsed = parseHead(this.#buf.subarray(0, end).toString("latin1"));
      if (typeof parsed === "string") return { kind: "error", reason: parsed };
      this.#buf = this.#buf.subarray(end + 4);
      this.#head = { ...parsed, continued: false };
    }
    const h = this.#head;
    if (h.expect && !h.continued && h.length !== 0) {
      h.continued = true;
      return { kind: "continue" };
    }
    let body: Buffer;
    if (h.length === "chunked") {
      const r = readChunked(this.#buf, this.#limits.bodyBytes);
      if (r === "need_more") return { kind: "need_more" };
      if (typeof r === "string") return { kind: "error", reason: r };
      body = r.body;
      this.#buf = this.#buf.subarray(r.consumed);
    } else {
      if (h.length > this.#limits.bodyBytes) return { kind: "error", reason: "body_too_large" };
      if (this.#buf.length < h.length) return { kind: "need_more" };
      body = this.#buf.subarray(0, h.length);
      this.#buf = this.#buf.subarray(h.length);
    }
    this.#head = undefined;
    return {
      kind: "request",
      request: { method: h.method, target: h.target, headers: h.headers, body, close: h.close },
    };
  }
}
