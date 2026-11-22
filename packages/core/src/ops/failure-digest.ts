// Extractive failure digest: the failing step's name and the first error block of its log, as
// found, never summarised. Pure text work; the op reads the log and applies redaction.
import { completeLength } from "./utf8";

/** Cap on one digest's text. */
export const DIGEST_BYTES = 2048;
const ERROR_LINES_AFTER = 12;
const ERROR_LINES_BEFORE = 2;
const NEAR_END_LINES = 120;
const TAIL_LINES = 15;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANNOTATION = /^\s*::error(?:\s|:)/;
const ERROR_LINE =
  /\b(error|errors|failed|failure|fatal|exception|panic|traceback|assertion|cannot|could not|not found|exited with|exit code [1-9])\b|✗|\bFAIL\b/i;

export type DigestBasis = "annotation" | "error_pattern" | "tail";

export function cleanLog(text: string): string {
  return text.replaceAll(ANSI, "").replaceAll("\r", "");
}

/**
 * Picks the excerpt: the first `::error` annotation block when there is one; else the first line
 * matching an error pattern in the last lines of the window (the failing step's end), with a
 * little context; else the last lines.
 */
export function pickExcerpt(text: string): { lines: string[]; basis: DigestBasis } {
  const lines = cleanLog(text).split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const ann = lines.findIndex((l) => ANNOTATION.test(l));
  if (ann >= 0) {
    let end = ann;
    while (end + 1 < lines.length && end - ann < 9 && ANNOTATION.test(lines[end + 1]!)) end++;
    return { lines: lines.slice(ann, end + 1), basis: "annotation" };
  }
  const regionStart = Math.max(0, lines.length - NEAR_END_LINES);
  for (let i = regionStart; i < lines.length; i++) {
    if (ERROR_LINE.test(lines[i]!)) {
      const from = Math.max(regionStart, i - ERROR_LINES_BEFORE);
      return { lines: lines.slice(from, i + ERROR_LINES_AFTER + 1), basis: "error_pattern" };
    }
  }
  return { lines: lines.slice(-TAIL_LINES), basis: "tail" };
}

/** Joins lines and cuts to the byte cap on a line boundary where possible, whole characters always. */
export function capExcerpt(text: string, max = DIGEST_BYTES): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  const whole = buf.subarray(0, completeLength(buf.subarray(0, max)));
  const nl = whole.lastIndexOf(0x0a);
  const kept = nl > max / 2 ? whole.subarray(0, nl) : whole;
  return { text: kept.toString("utf8"), truncated: true };
}
