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
/** Longest single header line accepted. */
export const MAX_HEADER_LINE = 8 * 1024;

/** Trims spaces and tabs from both ends in one linear pass. */
export function trimOws(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

/** The head of a request (request line and headers), or the reason it is refused. */
export function parseHead(text: string): Head | string {
  const lines = text.split("\r\n");
  const m = /^([A-Z]{3,10}) (\S+) HTTP\/1\.1$/.exec(lines[0] ?? "");
  if (!m) return "bad_request_line";
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (line.length > MAX_HEADER_LINE) return "header_line_too_long";
    if (line.startsWith(" ") || line.startsWith("\t")) return "obs_fold";
    // Split at the first colon and trim by hand: no pattern with a run of optional whitespace
    // that could backtrack on a hostile line.
    const colon = line.indexOf(":");
    if (colon < 1) return "bad_header";
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) return "bad_header";
    const value = trimOws(line.slice(colon + 1));
    // eslint-disable-next-line no-control-regex
    if (/[\u0000\r\n]/.test(value)) return "bad_header_value";
    headers.push([name.toLowerCase(), value]);
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

/** Longest chunk-size line, longest trailer line, and all trailers together. */
const MAX_CHUNK_LINE = 1024;
const MAX_TRAILER_LINE = 8192;
const MAX_TRAILER_BYTES = 16 * 1024;

/** Chunk framing is parsed once: where it stopped and what it decoded are kept between reads. */
interface ChunkState {
  pos: number;
  total: number;
  count: number;
  parts: Buffer[];
  trailer: boolean;
  trailerBytes: number;
}

const MAX_CHUNKS = 4096;

function newChunkState(): ChunkState {
  return { pos: 0, total: 0, count: 0, parts: [], trailer: false, trailerBytes: 0 };
}

/** Continues from `st.pos`; the buffer only ever grows at the end between calls. */
function readChunked(
  buf: Buffer,
  max: number,
  st: ChunkState,
): "need_more" | string | { body: Buffer; consumed: number } {
  for (;;) {
    if (st.trailer) {
      // Trailers are read and dropped, up to the terminating empty line, within a fixed budget.
      const e = buf.indexOf("\r\n", st.pos);
      if (e < 0) return buf.length - st.pos > MAX_TRAILER_LINE ? "bad_trailer" : "need_more";
      const lineLength = e - st.pos;
      st.pos = e + 2;
      if (lineLength === 0) return { body: Buffer.concat(st.parts), consumed: st.pos };
      st.trailerBytes += lineLength + 2;
      if (lineLength > MAX_TRAILER_LINE || st.trailerBytes > MAX_TRAILER_BYTES)
        return "bad_trailer";
      continue;
    }
    const eol = buf.indexOf("\r\n", st.pos);
    // A line that is already too long and still has no end is refused now, not waited for.
    if (eol < 0) return buf.length - st.pos > MAX_CHUNK_LINE ? "bad_chunk" : "need_more";
    if (eol - st.pos > MAX_CHUNK_LINE) return "bad_chunk";
    const sizeText = buf.subarray(st.pos, eol).toString("latin1").split(";", 1)[0]!.trim();
    if (!/^[0-9a-fA-F]{1,8}$/.test(sizeText)) return "bad_chunk";
    const size = Number.parseInt(sizeText, 16);
    if (size === 0) {
      st.pos = eol + 2;
      st.trailer = true;
      continue;
    }
    if (st.count + 1 > MAX_CHUNKS) return "chunk_limit";
    if (st.total + size > max) return "body_too_large";
    const start = eol + 2;
    if (buf.length < start + size + 2) return "need_more";
    if (buf.subarray(start + size, start + size + 2).toString("latin1") !== "\r\n") {
      return "bad_chunk";
    }
    st.count += 1;
    st.total += size;
    st.parts.push(buf.subarray(start, start + size));
    st.pos = start + size + 2;
  }
}

export class RequestReader {
  // Fed bytes go into a store that doubles when full, so many tiny reads cost linear time. Bytes
  // below #end are never rewritten (bodies handed out point into the store); a full store is
  // replaced by a bigger one.
  #store: Buffer = Buffer.alloc(0);
  #off = 0;
  #end = 0;
  readonly #limits: Limits;
  #head: (Head & { continued: boolean }) | undefined;
  #overflow = false;
  #chunks: ChunkState | undefined;

  constructor(limits: Limits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  /** Everything buffered, however it is framed, stays within one request's worth of bytes. */
  feed(chunk: Buffer): void {
    const cap = this.#limits.headerBytes + this.#limits.bodyBytes + 64 * 1024;
    const live = this.#end - this.#off;
    if (live + chunk.length > cap) {
      this.#overflow = true;
      this.#store = Buffer.alloc(0);
      this.#off = 0;
      this.#end = 0;
      return;
    }
    if (this.#end + chunk.length > this.#store.length) {
      const next = Buffer.allocUnsafe(Math.max(4096, 2 * (live + chunk.length)));
      this.#store.copy(next, 0, this.#off, this.#end);
      this.#store = next;
      this.#end = live;
      this.#off = 0;
    }
    chunk.copy(this.#store, this.#end);
    this.#end += chunk.length;
  }

  #view(): Buffer {
    return this.#store.subarray(this.#off, this.#end);
  }

  next(): ReadResult {
    if (this.#overflow) return { kind: "error", reason: "buffer_too_large" };
    if (!this.#head) {
      const end = this.#view().indexOf("\r\n\r\n");
      if (end < 0) {
        return this.#view().length > this.#limits.headerBytes
          ? { kind: "error", reason: "headers_too_large" }
          : { kind: "need_more" };
      }
      if (end > this.#limits.headerBytes) return { kind: "error", reason: "headers_too_large" };
      const parsed = parseHead(this.#view().subarray(0, end).toString("latin1"));
      if (typeof parsed === "string") return { kind: "error", reason: parsed };
      this.#off += end + 4;
      this.#head = { ...parsed, continued: false };
    }
    const h = this.#head;
    if (h.expect && !h.continued && h.length !== 0) {
      h.continued = true;
      return { kind: "continue" };
    }
    let body: Buffer;
    if (h.length === "chunked") {
      this.#chunks ??= newChunkState();
      const r = readChunked(this.#view(), this.#limits.bodyBytes, this.#chunks);
      if (r === "need_more") return { kind: "need_more" };
      if (typeof r === "string") return { kind: "error", reason: r };
      body = r.body;
      this.#chunks = undefined;
      this.#off += r.consumed;
    } else {
      if (h.length > this.#limits.bodyBytes) return { kind: "error", reason: "body_too_large" };
      if (this.#view().length < h.length) return { kind: "need_more" };
      body = this.#view().subarray(0, h.length);
      this.#off += h.length;
    }
    this.#head = undefined;
    return {
      kind: "request",
      request: { method: h.method, target: h.target, headers: h.headers, body, close: h.close },
    };
  }
}
