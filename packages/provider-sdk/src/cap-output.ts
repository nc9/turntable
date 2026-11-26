/** Output retention: first 1 MiB, last 64 MiB, plus slack before a cut is applied. */
export const OUTPUT_HEAD_BYTES = 1024 * 1024;
export const OUTPUT_TAIL_BYTES = 64 * 1024 * 1024;
export const OUTPUT_SLACK_BYTES = 64 * 1024;

export interface CapOptions {
  head?: number;
  tail?: number;
  slack?: number;
}

/**
 * Re-caps accumulated output to head + tail with the dropped region reported as data. Output at
 * or under head + tail + slack is returned unchanged. `cut.atOffset` is where, in the returned
 * bytes, the omitted region belongs. Use in the core reader, which may have read more than the
 * sandbox kept.
 */
export function capOutput(
  bytes: Uint8Array,
  opts: CapOptions = {},
): { bytes: Uint8Array; cut?: { atOffset: number; omittedBytes: number } } {
  const head = opts.head ?? OUTPUT_HEAD_BYTES;
  const tail = opts.tail ?? OUTPUT_TAIL_BYTES;
  const slack = opts.slack ?? OUTPUT_SLACK_BYTES;
  if (bytes.length <= head + tail + slack) return { bytes };
  const out = new Uint8Array(head + tail);
  out.set(bytes.subarray(0, head), 0);
  out.set(bytes.subarray(bytes.length - tail), head);
  return { bytes: out, cut: { atOffset: head, omittedBytes: bytes.length - head - tail } };
}
