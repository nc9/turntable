import {
  MAX_PATTERN_LENGTH,
  PATTERNS,
  PEM_BEGIN,
  PEM_END,
  PEM_END_MAX,
  REPLACEMENT,
} from "./patterns";
import { SecretRegistry } from "./registry";

/** A PEM block with no END marker after this many characters is swallowed to its END (or EOF). */
export const MAX_OPEN_PEM = 256 * 1024;

type Interval = { start: number; end: number };

/** Finds redaction intervals in `text`. `open` is the start of an unterminated PEM block. */
function findIntervals(
  text: string,
  registry: SecretRegistry | undefined,
): { intervals: Interval[]; openPemStart: number | undefined } {
  const intervals: Interval[] = [];
  let openPemStart: number | undefined;

  for (const p of PATTERNS) {
    if (p.needs !== undefined && !text.includes(p.needs)) continue;
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const keep = p.keepPrefix ? (m[1]?.length ?? 0) : 0;
      intervals.push({ start: m.index + keep, end: m.index + m[0].length });
    }
  }

  PEM_BEGIN.lastIndex = 0;
  let from = 0;
  for (;;) {
    PEM_BEGIN.lastIndex = from;
    const begin = PEM_BEGIN.exec(text);
    if (!begin) break;
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (!end) {
      // Everything after an unterminated BEGIN is held (or swallowed) until the END shows up.
      openPemStart = begin.index;
      intervals.push({ start: begin.index, end: Number.POSITIVE_INFINITY });
      break;
    }
    const endIdx = end.index + end[0].length;
    intervals.push({ start: begin.index, end: endIdx });
    from = endIdx;
  }

  if (registry) {
    for (const form of registry.forms()) {
      let at = text.indexOf(form);
      while (at !== -1) {
        intervals.push({ start: at, end: at + form.length });
        at = text.indexOf(form, at + 1);
      }
    }
  }
  return { intervals, openPemStart };
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.toSorted((a, b) => a.start - b.start || b.end - a.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out.at(-1);
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

function apply(text: string, merged: Interval[], limit: number): string {
  let out = "";
  let pos = 0;
  for (const iv of merged) {
    if (iv.start >= limit) break;
    out += text.slice(pos, iv.start) + REPLACEMENT;
    pos = iv.end;
  }
  return out + text.slice(pos, limit);
}

/** One-shot redaction of a complete string. */
export function redactString(text: string, registry?: SecretRegistry): string {
  const r = new Redactor({ registry });
  return r.push(text) + r.end();
}

/**
 * Streaming redactor. `push` chunks in, get redacted text out; call `end` once to flush.
 *
 * Mechanism: unemitted text is held in a carry buffer. Each `push` scans the whole buffer,
 * then emits everything up to the last newline (complete lines go out immediately) and holds
 * only the current incomplete line, capped at `window - 1` characters, where `window` is the
 * longest possible match (max of the built-in patterns and the longest registered value). A
 * long line therefore emits all but its last `window - 1` characters. If a match straddles the
 * emit boundary, the boundary moves back to the match start. The carry is kept raw and
 * rescanned with the next chunk, so a secret split at any offset is still found. A secret is
 * never emitted partially.
 *
 * Output length is not preserved: each secret becomes `***` regardless of its length, and
 * the incomplete last line (at most `window - 1` characters) is held until a newline, `end` or
 * `flushIdle`. Input may be strings or bytes; bytes are decoded as streaming UTF-8.
 * Cost is O(window) per `push`, so prefer chunks of a few KiB over single bytes.
 *
 * Unterminated PEM blocks are held until their END marker, up to MAX_OPEN_PEM characters, then
 * swallowed (replaced by one `***`) until the END marker or `end`.
 */
export class Redactor {
  #registry: SecretRegistry | undefined;
  #decoder = new TextDecoder("utf-8");
  #buf = "";
  #swallowing = false;
  #ended = false;

  constructor(opts: { registry?: SecretRegistry | undefined } = {}) {
    this.#registry = opts.registry;
  }

  push(chunk: string | Uint8Array): string {
    if (this.#ended) throw new Error("redactor already ended");
    this.#buf += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    return this.#drain("push");
  }

  /** Flushes and closes the stream. Call once, when the source ends. */
  end(): string {
    if (this.#ended) return "";
    this.#ended = true;
    this.#buf += this.#decoder.decode();
    return this.#drain("end");
  }

  /**
   * Emits the held partial line, redacted. Call it after about a second without input so the
   * tail of a slow or hung job becomes visible. Trade-off: a token split across the idle gap
   * leaks its first part (the part already emitted is not matched on its own). An unterminated
   * PEM block is emitted as `***` and the rest of it is swallowed until its END marker.
   */
  flushIdle(): string {
    if (this.#ended) return "";
    return this.#drain("idle");
  }

  #window(): number {
    return Math.max(MAX_PATTERN_LENGTH, this.#registry?.maxLength ?? 0);
  }

  #drain(mode: "push" | "idle" | "end"): string {
    const final = mode === "end";
    let out = "";
    // Swallow mode: drop everything until the END marker of an oversized PEM block.
    if (this.#swallowing) {
      PEM_END.lastIndex = 0;
      const end = PEM_END.exec(this.#buf);
      if (end) {
        this.#buf = this.#buf.slice(end.index + end[0].length);
        this.#swallowing = false;
      } else {
        this.#buf = final ? "" : this.#buf.slice(-PEM_END_MAX);
        return out;
      }
    }

    const text = this.#buf;
    const { intervals, openPemStart } = findIntervals(text, this.#registry);
    const merged = merge(intervals);

    if (final) {
      this.#buf = "";
      return out + apply(text, merged, text.length);
    }

    if (
      openPemStart !== undefined &&
      (mode === "idle" || text.length - openPemStart > MAX_OPEN_PEM)
    ) {
      out += apply(text, merged, openPemStart) + REPLACEMENT;
      this.#swallowing = true;
      this.#buf = text.slice(-PEM_END_MAX);
      return out;
    }

    if (mode === "idle") {
      this.#buf = "";
      return out + apply(text, merged, text.length);
    }

    // Hold at most the window, but only the current incomplete line: complete lines go out now.
    // Registered values with newlines can span lines, so they fall back to the window rule.
    const windowStart = Math.max(0, text.length - (this.#window() - 1));
    const lineStart = this.#registry?.hasNewline ? 0 : text.lastIndexOf("\n") + 1;
    let boundary = Math.max(windowStart, lineStart);
    // Do not split a match, or a surrogate pair.
    for (const iv of merged) {
      if (iv.start < boundary && iv.end > boundary) boundary = iv.start;
    }
    if (boundary > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(boundary))) boundary--;
    if (boundary <= 0) return out;
    this.#buf = text.slice(boundary);
    return out + apply(text, merged, boundary);
  }
}
