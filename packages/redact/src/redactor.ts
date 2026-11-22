import {
  COMPILED,
  MAX_PATTERN_LENGTH,
  PEM_BEGIN,
  PEM_END,
  KEY_GAP_MAX,
  KEY_LINE_END,
  KEY_LINE_SPAN,
  KEY_NAMES,
  PEM_END_MAX,
  REPLACEMENT,
} from "./patterns";
import { SecretRegistry } from "./registry";

/** A PEM block with no END marker after this many characters is swallowed to its END (or EOF). */
export const MAX_OPEN_PEM = 256 * 1024;

const PEM_MARKER = "-----BEGIN ";
const PEM_TAILS = ["PRIVATE KEY-----", "PRIVATE KEY BLOCK-----"];

const isKeyLine = (line: string): boolean => KEY_LINE_END.test(line.slice(-KEY_LINE_SPAN));

/**
 * Start of the key line (a line ending in a key name) that precedes the partial line with only
 * whitespace-only lines between them, if the gap is within what the patterns accept. That key
 * line must stay buffered: its value may still arrive.
 */
function prevKeyLineStart(text: string, partialStart: number): number {
  let lineEnd = partialStart - 1; // index of the "\n" ending the line above the partial line
  let gap = 0;
  while (lineEnd >= 0) {
    const lineStart = lineEnd === 0 ? 0 : text.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = text.slice(lineStart, lineEnd);
    if (/^\s*$/.test(line)) {
      // Conservative: twice the pattern's gap, since the key line's own trailing blanks count too.
      gap += line.length + 1;
      if (gap > 2 * KEY_GAP_MAX + 2) return Number.POSITIVE_INFINITY;
      lineEnd = lineStart - 1;
      continue;
    }
    return isKeyLine(line) ? lineStart : Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** Could `rest` (text after a PEM marker prefix) still grow into a private key BEGIN marker? */
function couldBecomeMarker(rest: string): boolean {
  if (rest.includes("\n")) return false;
  for (let j = 0; j <= rest.length; j++) {
    const label = rest.slice(0, j);
    if (label.length <= 40 && /^[A-Z0-9 ]*$/.test(label)) {
      const tail = rest.slice(j);
      if (PEM_TAILS.some((t) => t.startsWith(tail))) return true;
    }
  }
  return false;
}

/** Index from which a PEM BEGIN marker could still be forming at the end of `text`. */
function pemHoldStart(text: string): number {
  const len = text.length;
  let hold = Number.POSITIVE_INFINITY;
  // The marker itself cut short at the end of the text ("-----BE").
  for (let k = Math.min(PEM_MARKER.length - 1, len); k >= 1; k--) {
    if (text.endsWith(PEM_MARKER.slice(0, k))) {
      hold = len - k;
      break;
    }
  }
  // The marker complete, but the key label or the dashes after it still to come.
  const idx = text.lastIndexOf(PEM_MARKER);
  if (idx >= 0 && len - idx <= 130 && couldBecomeMarker(text.slice(idx + PEM_MARKER.length))) {
    hold = Math.min(hold, idx);
  }
  return hold;
}

/** Length of the longest proper prefix of `form` that is a suffix of `text` (KMP, linear). */
function overlap(text: string, form: string): number {
  const need = form.length - 1;
  const s = `${form}\u0000${need > 0 ? text.slice(-need) : ""}`;
  const pi = Array.from({ length: s.length }, () => 0);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1] ?? 0;
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1] ?? 0;
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  return Math.min(pi.at(-1) ?? 0, form.length - 1);
}

/** Enough characters past a run to see a whole key name or PEM marker start. */
const CONTEXT_LOOKAHEAD = 32;

/**
 * First index in `text` where a PEM BEGIN marker or a key name starts, at or before `limit`;
 * -1 if none.
 */
function contextStart(text: string, limit: number): number {
  const low = text.toLowerCase();
  const consider = (form: string, hay: string): number => {
    const full = hay.indexOf(form);
    // A start still being spelled at the very end of the text counts too: it may complete
    // in the next chunk, and then the run must not have swallowed its first letters.
    // (When the run itself reaches the end of the text, `contextHold` keeps that tail instead.)
    const k = hay.length > limit ? overlap(hay, form) : 0;
    const partial = k > 0 ? hay.length - k : -1;
    return full >= 0 && (partial < 0 || full < partial) ? full : partial;
  };
  let at = consider("-----BEGIN", text);
  for (const name of KEY_NAMES) {
    const i = consider(name, low);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at >= 0 && at <= limit ? at : -1;
}

/** Length of the tail of `text` that could still become the start of such a context. */
function contextHold(text: string): number {
  const low = text.slice(-24).toLowerCase();
  let hold = overlap(text, PEM_MARKER);
  for (const name of KEY_NAMES) hold = Math.max(hold, overlap(low, name));
  return hold;
}

/** Earliest index of `text` that must stay buffered when flushing on idle. */
function idleHoldStart(text: string, registry: SecretRegistry | undefined): number {
  const partialStart = text.lastIndexOf("\n") + 1;
  let hold = Math.min(text.length, prevKeyLineStart(text, partialStart));
  // The partial line itself ends with a key name: its value has not arrived.
  if (isKeyLine(text.slice(partialStart))) hold = Math.min(hold, partialStart);
  hold = Math.min(hold, pemHoldStart(text));
  // A key name cut mid-word: "aws_secr" + "et_access_key:" would otherwise slip through.
  const lowTail = text.slice(-24).toLowerCase();
  for (const name of KEY_NAMES) {
    const k = overlap(lowTail, name);
    if (k > 0) hold = Math.min(hold, text.length - k);
  }
  if (registry) {
    for (const form of registry.forms()) {
      const k = overlap(text, form);
      if (k > 0) hold = Math.min(hold, text.length - k);
    }
  }
  return hold;
}

/**
 * `start`..`end` is replaced; `full` is where the whole match begins (a kept prefix included),
 * so the stream is never cut inside a match. `open` is set when a token's run reached the end
 * of the buffer and may continue in the next chunk.
 */
type Interval = {
  start: number;
  end: number;
  full: number;
  /** The token's run reached the end of the buffer; `hold` trailing chars stay raw (see below). */
  open?: { re: RegExp; hold: number };
};

/** Finds redaction intervals in `text`. `open` is the start of an unterminated PEM block. */
function findIntervals(
  text: string,
  registry: SecretRegistry | undefined,
): { intervals: Interval[]; openPemStart: number | undefined } {
  const intervals: Interval[] = [];
  let openPemStart: number | undefined;

  for (const p of COMPILED) {
    if (p.needs !== undefined && !text.includes(p.needs)) continue;
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      const keep = p.keepPrefix ? (m[1]?.length ?? 0) : 0;
      let end = m.index + m[0].length;
      let open: Interval["open"];
      // The match hit its upper bound if the next character still belongs to the token: carry
      // the redaction through the rest of the run. Resume matching after it (linear overall).
      if (p.runRe && p.triggerRe && end < text.length && p.triggerRe.test(text.charAt(end))) {
        p.runRe.lastIndex = end;
        const run = p.runRe.exec(text);
        const runEnd = end + (run ? run[0].length : 0);
        const ext = text.slice(end, runEnd);
        // A run never swallows context that starts something else (a PEM BEGIN marker, a key
        // name): stop there, so that it is scanned in its own right. The name may extend past
        // the run's character class (`aws` | `_secret_access_key`), so look a little beyond it.
        const cut = contextStart(text.slice(end, runEnd + CONTEXT_LOOKAHEAD), ext.length);
        if (cut >= 0) {
          end += cut;
        } else {
          end = runEnd;
          if (end === text.length) {
            // Keep a tail that could still grow into such a start raw; the rest is replaced now
            // and the continuation of the run is dropped as it arrives.
            const hold = contextHold(ext);
            end -= hold;
            open = { re: new RegExp(`^[${p.run}]*`), hold };
          }
        }
        p.re.lastIndex = Math.max(p.re.lastIndex, end);
      }
      intervals.push({ start: m.index + keep, end, full: m.index, ...(open ? { open } : {}) });
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
      intervals.push({
        start: begin.index,
        end: Number.POSITIVE_INFINITY,
        full: begin.index,
      });
      break;
    }
    const endIdx = end.index + end[0].length;
    intervals.push({ start: begin.index, end: endIdx, full: begin.index });
    from = endIdx;
  }

  if (registry) {
    for (const form of registry.forms()) {
      let at = text.indexOf(form);
      while (at !== -1) {
        intervals.push({ start: at, end: at + form.length, full: at });
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
    if (last && iv.start <= last.end) {
      last.full = Math.min(last.full, iv.full);
      if (iv.end > last.end) {
        last.end = iv.end;
        if (iv.open) last.open = iv.open;
        else delete last.open;
      } else if (iv.end === last.end && iv.open) last.open = iv.open;
    } else out.push({ ...iv });
  }
  return out;
}

/** Moves `boundary` back until no match (from its first character, prefix included) straddles it. */
function settle(boundary: number, merged: Interval[]): number {
  let b = boundary;
  for (let moved = true; moved;) {
    moved = false;
    for (const iv of merged) {
      if (iv.full < b && iv.end > b) {
        b = iv.full;
        moved = true;
      }
    }
  }
  return b;
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
  /** Set while an over-long token continues across chunks: its characters are dropped. */
  #tokenRun: RegExp | undefined;
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
    // An over-long token was already replaced by `***`: drop the rest of its run.
    if (this.#tokenRun) {
      const run = this.#tokenRun.exec(this.#buf);
      const n = run ? run[0].length : 0;
      const consumed = this.#buf.slice(0, n);
      // The dropped tail must not hide context that starts something else: a PEM BEGIN marker
      // or a key name inside the run. Stop dropping there and scan from that point.
      const cut = contextStart(this.#buf.slice(0, n + CONTEXT_LOOKAHEAD), n);
      if (cut >= 0) {
        this.#buf = this.#buf.slice(cut);
        this.#tokenRun = undefined;
      } else if (n === this.#buf.length && !final) {
        // The run reaches the end: keep only a tail that could still grow into such a start.
        const keep = contextHold(consumed);
        this.#buf = this.#buf.slice(n - keep);
        return out;
      } else {
        this.#buf = this.#buf.slice(n);
        this.#tokenRun = undefined;
      }
    }
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

    // A token whose run reaches the end of the buffer may go on in the next chunk: emit the
    // replacement now and drop the continuation as it arrives (bounded memory).
    const last = merged.at(-1);
    if (last?.open && last.end + last.open.hold === text.length) {
      this.#tokenRun = last.open.re;
      this.#buf = text.slice(last.end);
      return out + apply(text, merged, last.end);
    }

    if (mode === "idle") {
      const boundary = settle(idleHoldStart(text, this.#registry), merged);
      this.#buf = text.slice(boundary);
      return out + apply(text, merged, boundary);
    }

    // Hold at most the window, but only the current incomplete line: complete lines go out now.
    // Registered values with newlines can span lines, so they fall back to the window rule.
    const windowStart = Math.max(0, text.length - (this.#window() - 1));
    // A complete line ending in a key name (value on the next line) is held with the partial one.
    const partialStart = text.lastIndexOf("\n") + 1;
    const lineStart = this.#registry?.hasNewline
      ? 0
      : Math.min(partialStart, prevKeyLineStart(text, partialStart));
    // Do not split a match (its prefix included), or a surrogate pair.
    let boundary = settle(Math.max(windowStart, lineStart), merged);
    if (boundary > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(boundary))) boundary--;
    if (boundary <= 0) return out;
    this.#buf = text.slice(boundary);
    return out + apply(text, merged, boundary);
  }
}
