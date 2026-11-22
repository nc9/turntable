// A tiny X.509 builder for tests: enough DER to make an EC P-256 root and a leaf attestation
// certificate (with the FIDO AAGUID extension) at runtime, so no private key sits in the repo.
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";

const len = (n: number): Buffer =>
  n < 128
    ? Buffer.from([n])
    : n < 256
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 255]);
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const oid = (dotted: string): Buffer => {
  const n = dotted.split(".").map(Number);
  const out: number[] = [n[0]! * 40 + n[1]!];
  for (const v of n.slice(2)) {
    const stack = [v & 127];
    let x = v >> 7;
    while (x > 0) {
      stack.unshift((x & 127) | 128);
      x >>= 7;
    }
    out.push(...stack);
  }
  return der(0x06, Buffer.from(out));
};
const seq = (...p: Buffer[]) => der(0x30, ...p);
const name = (cn: string) => seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));
const time = (d: Date) =>
  der(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

export type TestCert = { cert: X509Certificate; der: Buffer; key: KeyObject };

export function makeCert(o: {
  cn: string;
  issuer?: { cn: string; key: KeyObject };
  ca: boolean;
  aaguid?: Buffer;
  notBefore?: Date;
  notAfter?: Date;
}): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const issuer = o.issuer ?? { cn: o.cn, key: privateKey };
  const ext: Buffer[] = [
    seq(
      oid("2.5.29.19"),
      der(0x01, Buffer.from([0xff])),
      der(0x04, seq(...(o.ca ? [der(0x01, Buffer.from([0xff]))] : []))),
    ),
  ];
  if (o.aaguid) ext.push(seq(oid("1.3.6.1.4.1.45724.1.1.4"), der(0x04, der(0x04, o.aaguid))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1, Math.floor(Math.random() * 120) + 1])),
    ECDSA_SHA256,
    name(issuer.cn),
    seq(
      time(o.notBefore ?? new Date(Date.now() - 86_400_000)),
      time(o.notAfter ?? new Date(Date.now() + 10 * 365 * 86_400_000)),
    ),
    name(o.cn),
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(...ext)),
  );
  const sig = sign("sha256", tbs, issuer.key);
  const certDer = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { cert: new X509Certificate(certDer), der: certDer, key: privateKey };
}
