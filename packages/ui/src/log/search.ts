import type { LogLine } from "./parser";

export type Match = { line: number; start: number; end: number };

export const MAX_MATCHES = 5000;

/**
 * Case-insensitive substring search over parsed lines (plain text, escapes already stripped).
 * Pass `fromLine` to continue after new lines were appended.
 */
export function findMatches(
  lines: readonly LogLine[],
  query: string,
  fromLine = 0,
  into: Match[] = [],
): Match[] {
  if (query === "") return into;
  const q = query.toLowerCase();
  for (let i = fromLine; i < lines.length && into.length < MAX_MATCHES; i++) {
    const text = (lines[i] as LogLine).text;
    if (text.length < q.length) continue;
    const hay = text.toLowerCase();
    let at = hay.indexOf(q);
    while (at !== -1 && into.length < MAX_MATCHES) {
      into.push({ line: i, start: at, end: at + q.length });
      at = hay.indexOf(q, at + q.length);
    }
  }
  return into;
}
