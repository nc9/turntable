// Who the client of a request really is. A rate limit keyed on a spoofable header is no limit,
// so the forwarded chain is believed only for the hops an operator named as their own proxies
// (LONGSHORE_TRUSTED_PROXIES: comma-separated addresses and CIDR ranges). The client is the first
// hop, walking from the right, that is not one of them; and the chain is read at all only when
// the socket peer itself is a trusted proxy.
import { parseIp, type ParsedIp } from "@longshore/net";

interface Range {
  family: 4 | 6;
  bytes: Uint8Array;
  bits: number;
}

export interface TrustedProxies {
  readonly empty: boolean;
  isTrusted(ip: string): boolean;
}

/** `::ffff:a.b.c.d` is the IPv4 address a.b.c.d. */
function normalise(p: ParsedIp): ParsedIp {
  if (p.family === 6) {
    const b = p.bytes;
    const mapped = b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
    if (mapped) return { family: 4, bytes: b.subarray(12, 16) };
  }
  return p;
}

const covers = (r: Range, ip: ParsedIp): boolean => {
  if (r.family !== ip.family) return false;
  const whole = Math.floor(r.bits / 8);
  for (let i = 0; i < whole; i += 1) if (r.bytes[i] !== ip.bytes[i]) return false;
  const rest = r.bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((r.bytes[whole] as number) & mask) === ((ip.bytes[whole] as number) & mask);
};

export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
  const ranges: Range[] = [];
  for (const entry of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [addr, prefix, extra] = entry.split("/");
    const p = addr ? parseIp(addr) : undefined;
    if (!p || extra !== undefined)
      throw new Error(`LONGSHORE_TRUSTED_PROXIES: not an address or range: ${entry}`);
    const n = normalise(p);
    const max = n.family === 4 ? 32 : 128;
    // an IPv4-mapped IPv6 range counts its prefix in IPv6 bits: keep it simple and exact
    const bits =
      prefix === undefined ? max : Number(prefix) - (p.family === 6 && n.family === 4 ? 96 : 0);
    if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || bits < 0 || bits > max)) {
      throw new Error(`LONGSHORE_TRUSTED_PROXIES: bad prefix length in ${entry}`);
    }
    ranges.push({ family: n.family, bytes: n.bytes, bits });
  }
  return {
    empty: ranges.length === 0,
    isTrusted(ip) {
      const p = parseIp(ip);
      if (!p) return false;
      const n = normalise(p);
      return ranges.some((r) => covers(r, n));
    },
  };
}

/**
 * The client address to key a limiter on. No trusted proxy configured, or a peer that is not one:
 * the peer (whatever the headers say). Otherwise the right-most forwarded hop that is not itself
 * trusted; if every hop is trusted, or the header is unusable, the peer.
 */
export function clientAddress(
  headers: Headers,
  peer: string | undefined,
  trusted: TrustedProxies,
): string {
  const socket = peer ?? "unknown";
  if (trusted.empty || peer === undefined || !trusted.isTrusted(peer)) return socket;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] as string;
    const p = parseIp(hop);
    if (!p) return socket; // an unusable hop: do not guess past it
    if (!trusted.isTrusted(hop)) return hop;
  }
  return socket;
}
