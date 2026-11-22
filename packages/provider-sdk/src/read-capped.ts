import { FileTooLargeError } from "./errors";

/**
 * Reads a response body into memory without ever holding more than `maxBytes` of it. A declared
 * `content-length` over the cap is refused before reading; otherwise bytes are counted as chunks
 * arrive and the stream is cancelled the moment the total passes the cap. A missing or lying
 * content-length therefore cannot make the caller buffer an unbounded body.
 *
 * Throws FileTooLargeError when the body is larger than `maxBytes`.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be a non-negative integer");
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FileTooLargeError(
      `response declares ${declared} bytes, over the ${maxBytes} byte limit`,
    );
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FileTooLargeError(`response body is over the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `readCapped` decoded as UTF-8 text. */
export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(res, maxBytes));
}

/** `readCapped` parsed as JSON. */
export async function readCappedJson<T>(res: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readCappedText(res, maxBytes)) as T;
}
