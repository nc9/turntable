/** Output retention: first 1 MiB, last 4 MiB, plus slack before a cut is applied. */
export const OUTPUT_HEAD_BYTES = 1024 * 1024;
export const OUTPUT_TAIL_BYTES = 4 * 1024 * 1024;
export const OUTPUT_SLACK_BYTES = 64 * 1024;

export interface CapOptions {
  head?: number;
  tail?: number;
  slack?: number;
}

export function cutMarker(omittedBytes: number): Uint8Array {
  return new TextEncoder().encode(`\n[turntable: ${omittedBytes} bytes of output omitted]\n`);
}

/**
 * Re-caps accumulated output to head + marker + tail. Output at or under head + tail + slack is
 * returned unchanged. Use in the core reader, which may have read more than the sandbox kept.
 */
export function capOutput(bytes: Uint8Array, opts: CapOptions = {}): Uint8Array {
  const head = opts.head ?? OUTPUT_HEAD_BYTES;
  const tail = opts.tail ?? OUTPUT_TAIL_BYTES;
  const slack = opts.slack ?? OUTPUT_SLACK_BYTES;
  if (bytes.length <= head + tail + slack) return bytes;
  const marker = cutMarker(bytes.length - head - tail);
  const out = new Uint8Array(head + marker.length + tail);
  out.set(bytes.subarray(0, head), 0);
  out.set(marker, head);
  out.set(bytes.subarray(bytes.length - tail), head + marker.length);
  return out;
}
