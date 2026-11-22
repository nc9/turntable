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
const rdn = (o: string, v: string) => der(0x31, seq(oid(o), der(0x0c, Buffer.from(v))));
const name = (cn: string, ou?: string) =>
  seq(...(ou ? [rdn("2.5.4.11", ou)] : []), rdn("2.5.4.3", cn));
const time = (d: Date) =>
  der(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z"));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

export type TestCert = { cert: X509Certificate; der: Buffer; key: KeyObject };

export function makeCert(o: {
  cn: string;
  issuer?: { cn: string; key: KeyObject };
  ca: boolean;
  aaguid?: Buffer;
  /** Subject OU; a non-CA certificate gets "Authenticator Attestation" unless this is null. */
  ou?: string | null;
  /** Mark the AAGUID extension critical (it must not be). */
  aaguidCritical?: boolean;
  pathLen?: number;
  /** An extra extension whose value contains the AAGUID extension's OID bytes, unread. */
  decoy?: Buffer;
  /** X.509 version number (default 3). */
  version?: number;
  notBefore?: Date;
  notAfter?: Date;
}): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const issuer = o.issuer ?? { cn: o.cn, key: privateKey };
  const ext: Buffer[] = [
    seq(
      oid("2.5.29.19"),
      der(0x01, Buffer.from([0xff])),
      der(
        0x04,
        seq(
          ...(o.ca ? [der(0x01, Buffer.from([0xff]))] : []),
          ...(o.pathLen === undefined ? [] : [der(0x02, Buffer.from([o.pathLen]))]),
        ),
      ),
    ),
  ];
  if (o.aaguid)
    ext.push(
      seq(
        oid("1.3.6.1.4.1.45724.1.1.4"),
        ...(o.aaguidCritical ? [der(0x01, Buffer.from([0xff]))] : []),
        der(0x04, der(0x04, o.aaguid)),
      ),
    );
  if (o.decoy) ext.push(seq(oid("2.5.29.17"), der(0x04, o.decoy)));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([(o.version ?? 3) - 1]))),
    der(0x02, Buffer.from([1, Math.floor(Math.random() * 120) + 1])),
    ECDSA_SHA256,
    name(issuer.cn),
    seq(
      time(o.notBefore ?? new Date(Date.now() - 86_400_000)),
      time(o.notAfter ?? new Date(Date.now() + 10 * 365 * 86_400_000)),
    ),
    name(
      o.cn,
      o.ou === null ? undefined : (o.ou ?? (o.ca ? undefined : "Authenticator Attestation")),
    ),
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(...ext)),
  );
  const sig = sign("sha256", tbs, issuer.key);
  const certDer = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  // Node refuses to parse v1 and v2 certificates that carry extensions, so for those only the DER
  // is returned (the attestation code must refuse them on its own).
  const cert = (o.version ?? 3) === 3 ? new X509Certificate(certDer) : (undefined as never);
  return { cert, der: certDer, key: privateKey };
}
