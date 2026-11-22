// Address classification for the SSRF guard. Everything not provably public is refused: the
// private, loopback, link-local (including the cloud metadata address), CGNAT, documentation,
// multicast and reserved ranges, and any IPv6 form that embeds an IPv4 address (mapped, NAT64,
// 6to4, compatible) is judged by the IPv4 address inside it.
import { isIP } from "node:net";

export interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

function parseV4(s: string): Uint8Array | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (const [i, p] of parts.entries()) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | undefined {
  if (input.includes("%")) return undefined; // zone ids are never a public address
  let s = input;
  // An embedded dotted IPv4 tail becomes two hextets.
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    const h = (a: number, b: number): string => ((a << 8) | b).toString(16);
    s = `${s.slice(0, lastColon + 1)}${h(v4[0] as number, v4[1] as number)}:${h(v4[2] as number, v4[3] as number)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): string[] | undefined => {
    if (part === "") return [];
    const g = part.split(":");
    return g.every((x) => /^[0-9a-fA-F]{1,4}$/.test(x)) ? g : undefined;
  };
  const head = toGroups(halves[0] as string);
  const tail = halves.length === 2 ? toGroups(halves[1] as string) : [];
  if (!head || !tail) return undefined;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  const out = new Uint8Array(16);
  for (const [i, g] of groups.entries()) {
    const n = Number.parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

/** Parses an IPv4 or IPv6 literal (no brackets). Undefined when it is neither. */
export function parseIp(s: string): ParsedIp | undefined {
  const fam = isIP(s);
  if (fam === 4) {
    const b = parseV4(s);
    return b ? { family: 4, bytes: b } : undefined;
  }
  if (fam === 6) {
    const b = parseV6(s);
    return b ? { family: 6, bytes: b } : undefined;
  }
  return undefined;
}

function inCidr(bytes: Uint8Array, base: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i += 1) if (bytes[i] !== base[i]) return false;
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((bytes[full] as number) & mask) === ((base[full] as number) & mask);
}

const v4 = (s: string): Uint8Array => parseV4(s) as Uint8Array;
const v6 = (s: string): Uint8Array => parseV6(s) as Uint8Array;

const BLOCKED_V4: [string, number, string][] = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private (RFC1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local (includes cloud metadata)"],
  ["172.16.0.0", 12, "private (RFC1918)"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay anycast"],
  ["192.168.0.0", 16, "private (RFC1918)"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
].map(([a, b, c]) => [a as string, b as number, c as string]);

const BLOCKED_V6: [string, number, string][] = [
  ["::", 96, "unspecified, loopback or IPv4-compatible"],
  ["64:ff9b:1::", 48, "local-use NAT64"],
  ["100::", 64, "discard-only"],
  ["2001::", 23, "IETF protocol assignments (Teredo, ORCHID)"],
  ["2001:db8::", 32, "documentation"],
  ["3fff::", 20, "documentation (RFC 9637)"],
  ["fc00::", 7, "unique local (ULA)"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
].map(([a, b, c]) => [a as string, b as number, c as string]);

function classifyV4(b: Uint8Array): string | undefined {
  for (const [base, bits, label] of BLOCKED_V4) if (inCidr(b, v4(base), bits)) return label;
  return undefined;
}

/**
 * Why `ip` must not be contacted, or undefined when it is a public address. IPv6 forms that carry
 * an IPv4 address (::ffff:a.b.c.d, 64:ff9b::/96, 2002::/16) are judged by that IPv4 address.
 */
export function blockedReason(ip: string): string | undefined {
  const p = parseIp(ip);
  if (!p) return "not an IP address";
  if (p.family === 4) return classifyV4(p.bytes);
  const b = p.bytes;
  if (inCidr(b, v6("::ffff:0:0"), 96)) {
    const r = classifyV4(b.subarray(12));
    return r ? `IPv4-mapped ${r}` : undefined;
  }
  if (inCidr(b, v6("64:ff9b::"), 96)) {
    const r = classifyV4(b.subarray(12));
    return r ? `NAT64 of ${r}` : undefined;
  }
  if (inCidr(b, v6("2002::"), 16)) {
    const r = classifyV4(b.subarray(2, 6));
    return r ? `6to4 of ${r}` : undefined;
  }
  for (const [base, bits, label] of BLOCKED_V6) if (inCidr(b, v6(base), bits)) return label;
  // Default deny: only global unicast (2000::/3) is public. This also refuses IPv4-translated
  // (::ffff:0:a.b.c.d) and any other space a table might miss.
  if (!inCidr(b, v6("2000::"), 3)) return "not global unicast";
  return undefined;
}
