// Removes every registered secret form from a response, bytes and header values alike.
import { REPLACEMENT, type SecretRegistry } from "@turntable/redact";

/** Replaces each form (longest first) in `buf`; returns the new bytes and how many were replaced. */
export function scrubBytes(
  buf: Buffer,
  forms: readonly string[],
): { bytes: Buffer; count: number } {
  let out = buf;
  let count = 0;
  const mark = Buffer.from(REPLACEMENT);
  for (const form of forms) {
    const needle = Buffer.from(form);
    if (needle.length === 0) continue;
    let from = 0;
    let at = out.indexOf(needle, from);
    if (at < 0) continue;
    const parts: Buffer[] = [];
    while (at >= 0) {
      parts.push(out.subarray(from, at), mark);
      from = at + needle.length;
      count++;
      at = out.indexOf(needle, from);
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return { bytes: out, count };
}

export function scrubText(text: string, forms: readonly string[]): { text: string; count: number } {
  const r = scrubBytes(Buffer.from(text, "latin1"), forms);
  return { text: r.bytes.toString("latin1"), count: r.count };
}

export const formsOf = (registry: SecretRegistry): string[] => registry.forms();
