// grep over a stored job log, with context, bounded work and a continuation offset.
import { redactString } from "@turntable/redact";
import { OpError } from "./errors";
import { compileSafeRegex, SafeRegexError, type LineMatcher } from "./safe-regex";

/** Most log bytes one call scans. A bigger log is paged with next_offset. */
export const GREP_SCAN_BYTES = 4 * 1024 * 1024;
const BLOCK = 256 * 1024;
/** Lines are matched on their first MATCH_CHARS characters and shown cut at SHOW_CHARS. */
const MATCH_CHARS = 2000;
const SHOW_CHARS = 500;
/** Wall-clock budget, checked between lines. */
const DEADLINE_MS = 2000;
const NL = 0x0a;

export type GrepInput = {
  pattern: string;
  regex: boolean;
  ignoreCase: boolean;
  context: number;
  maxMatches: number;
  maxBytes: number;
};

export type GrepResult = {
  text: string;
  matches: number;
  /** First byte scanned. */
  start: number;
  /** Where to continue; null when the scan reached the end of the log. */
  next: number | null;
  scannedBytes: number;
};

function matcherFor(input: GrepInput): LineMatcher {
  if (input.regex) {
    try {
      return compileSafeRegex(input.pattern, { ignoreCase: input.ignoreCase });
    } catch (err) {
      if (err instanceof SafeRegexError) {
        throw new OpError("invalid_input", `pattern not supported: ${err.message}`);
      }
      throw err;
    }
  }
  if (input.ignoreCase) {
    const needle = input.pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(input.pattern);
}

type Line = { offset: number; end: number; text: string };

/** Lines of the log in [start, scanEnd), read in blocks. A trailing line cut by scanEnd is not yielded. */
async function* lineStream(
  read: (from: number, to: number) => Promise<Buffer>,
  start: number,
  scanEnd: number,
  atLogEnd: boolean,
): AsyncGenerator<Line> {
  let pos = start;
  let carry: Buffer = Buffer.alloc(0);
  let carryStart = start;
  for (;;) {
    let chunk: Buffer = Buffer.alloc(0);
    if (pos < scanEnd) {
      chunk = await read(pos, Math.min(scanEnd, pos + BLOCK));
      pos = chunk.length === 0 ? scanEnd : pos + chunk.length;
    }
    const final = pos >= scanEnd;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const base = carryStart;
    let from = 0;
    for (;;) {
      const nl = buf.indexOf(NL, from);
      let stop: number; // index where the line's text ends
      let end: number; // index just past the line
      if (nl >= 0) {
        stop = nl;
        end = nl + 1;
      } else if (final && atLogEnd && from < buf.length) {
        stop = end = buf.length;
      } else if (buf.length - from >= BLOCK) {
        // A line longer than a block is split rather than held in memory.
        stop = end = buf.length;
      } else break;
      const slice = buf.subarray(from, stop);
      yield {
        offset: base + from,
        end: base + end,
        text: slice
          .subarray(0, MATCH_CHARS * 4)
          .toString("utf8")
          .replace(/\r$/, ""),
      };
      from = end;
    }
    carry = buf.subarray(from);
    carryStart = base + from;
    if (final) return;
  }
}

/**
 * Scans the log from `start` for lines matching the pattern. `read(from, to)` returns raw log
 * bytes. Stops after maxMatches (plus their trailing context), at the scan cap, at the output
 * cap, or at the deadline, and says where to continue.
 */
export async function grepLog(
  read: (from: number, to: number) => Promise<Buffer>,
  total: number,
  start: number,
  input: GrepInput,
  now: () => number = Date.now,
): Promise<GrepResult> {
  const match = matcherFor(input);
  const deadline = now() + DEADLINE_MS;
  const scanEnd = Math.min(total, start + GREP_SCAN_BYTES);
  const out: string[] = [];
  let outBytes = 0;
  let matches = 0;
  let afterLeft = 0;
  let shownEnd = -1; // end offset of the last line written, to place `--` between groups
  let before: Line[] = [];
  let lastEnd = start; // end of the last line fully handled
  let stoppedAt: number | undefined;

  const show = (ln: Line, sep: ":" | "-"): boolean => {
    const cut =
      ln.text.length > SHOW_CHARS ? `${ln.text.slice(0, SHOW_CHARS)} [line cut]` : ln.text;
    const row = `${ln.offset}${sep}${redactString(cut)}\n`;
    const gap = input.context > 0 && shownEnd >= 0 && shownEnd !== ln.offset ? "--\n" : "";
    const size = Buffer.byteLength(row) + gap.length;
    if (outBytes + size > input.maxBytes) return false;
    out.push(gap + row);
    outBytes += size;
    shownEnd = ln.end;
    return true;
  };

  for await (const ln of lineStream(read, start, scanEnd, scanEnd === total)) {
    if (now() > deadline) {
      stoppedAt = lastEnd;
      break;
    }
    const hit = match(ln.text.length > MATCH_CHARS ? ln.text.slice(0, MATCH_CHARS) : ln.text);
    let ok = true;
    let failedAt = ln.offset;
    if (hit && matches < input.maxMatches) {
      for (const b of before) {
        if (!show(b, "-")) {
          ok = false;
          failedAt = b.offset;
          break;
        }
      }
      before = [];
      if (ok) ok = show(ln, ":");
      if (ok) {
        matches++;
        afterLeft = input.context;
      }
    } else if (afterLeft > 0) {
      ok = show(ln, "-");
      if (ok) afterLeft--;
    } else if (input.context > 0) {
      before.push(ln);
      if (before.length > input.context) before.shift();
    }
    if (!ok) {
      // Output is full: continue from the first line that did not fit.
      stoppedAt = failedAt;
      break;
    }
    lastEnd = ln.end;
    if (matches >= input.maxMatches && afterLeft === 0) {
      stoppedAt = lastEnd;
      break;
    }
  }

  const resumeAt = stoppedAt ?? lastEnd;
  const doneAll = stoppedAt === undefined && scanEnd === total;
  return {
    text: out.join(""),
    matches,
    start,
    next: doneAll || resumeAt >= total ? null : resumeAt,
    scannedBytes: Math.max(0, resumeAt - start),
  };
}
