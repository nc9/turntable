// What KMS does for MessageType DIGEST: ECDSA over a digest that is already hashed. node:crypto
// always hashes its input, so the fake KMS in the tests does the arithmetic itself (P-256, BigInt).
import crypto from "node:crypto";

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G: [bigint, bigint] = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];
const mod = (a: bigint, m = P): bigint => ((a % m) + m) % m;
function inv(a: bigint, m = P): bigint {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}
type Pt = [bigint, bigint] | null;
function add(p: Pt, q: Pt): Pt {
  if (!p) return q;
  if (!q) return p;
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null;
  const l =
    p[0] === q[0]
      ? mod((3n * p[0] * p[0] + A) * inv(2n * p[1]))
      : mod((q[1] - p[1]) * inv(q[0] - p[0]));
  const x = mod(l * l - p[0] - q[0]);
  return [x, mod(l * (p[0] - x) - p[1])];
}
function mul(k: bigint, p: Pt): Pt {
  let r: Pt = null;
  for (; k > 0n; k >>= 1n, p = add(p, p)) if (k & 1n) r = add(r, p);
  return r;
}
const der = (n: bigint): Buffer => {
  let b = Buffer.from(n.toString(16).padStart(64, "0"), "hex");
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([2, b.length]), b]);
};

/** A DER ECDSA signature over `digest` (32 bytes), without hashing it again. */
export function signDigest(privateKey: crypto.KeyObject, digest: Buffer): Buffer {
  const d = BigInt(
    `0x${Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url").toString("hex")}`,
  );
  const z = BigInt(`0x${digest.toString("hex")}`);
  for (;;) {
    const k = BigInt(`0x${crypto.randomBytes(32).toString("hex")}`) % N;
    if (k === 0n) continue;
    const r = mod(mul(k, G)![0], N);
    const s = mod(inv(k, N) * (z + r * d), N);
    if (r === 0n || s === 0n) continue;
    const body = Buffer.concat([der(r), der(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
}
