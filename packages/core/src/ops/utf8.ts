/**
 * Byte-range reads can cut a UTF-8 character in half. These trim a buffer to whole characters
 * so text never contains a replacement character and paging by byte offset is lossless: the
 * trimmed bytes are the start of the next page.
 */

/** Number of leading continuation bytes (0b10xxxxxx) to skip, at most 3. */
export function leadingPartial(buf: Uint8Array): number {
  let n = 0;
  while (n < 3 && n < buf.length && (buf[n]! & 0xc0) === 0x80) n++;
  return n;
}

/** Length of `buf` without a trailing incomplete character. */
export function completeLength(buf: Uint8Array): number {
  const len = buf.length;
  for (let back = 1; back <= 4 && back <= len; back++) {
    const b = buf[len - back]!;
    if ((b & 0xc0) === 0x80) continue; // continuation: keep looking for its lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? len - back : len;
  }
  return len;
}
