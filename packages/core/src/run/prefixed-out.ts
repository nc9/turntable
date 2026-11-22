/** Prefixes each line of a job's terminal output with its key. Stored logs stay unprefixed. */
export function prefixedOut(
  out: (t: string) => void,
  key: string,
): { out: (t: string) => void; flush: () => void } {
  let held = "";
  return {
    out(text) {
      held += text;
      const lines = held.split("\n");
      held = lines.pop() ?? "";
      if (lines.length > 0) out(lines.map((l) => `[${key}] ${l}\n`).join(""));
    },
    flush() {
      if (held) out(`[${key}] ${held}\n`);
      held = "";
    },
  };
}
