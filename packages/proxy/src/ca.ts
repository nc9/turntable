// A certificate authority for one attempt, built in-process with node:crypto (no openssl, so it
// works in the single binary). X.509 is written as DER by hand for the one profile needed:
// ECDSA P-256 / SHA-256, a self-signed CA and server leaves with a DNS name.
import crypto from "node:crypto";

const len = (n: number): Buffer =>
  n < 128
    ? Buffer.from([n])
    : n < 256
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const oid = (s: string): Buffer => {
  const a = s.split(".").map(Number);
  const out: number[] = [a[0]! * 40 + a[1]!];
  for (const n of a.slice(2)) {
    const t = [n & 127];
    for (let v = n >> 7; v > 0; v >>= 7) t.unshift((v & 127) | 128);
    out.push(...t);
  }
  return tlv(0x06, Buffer.from(out));
};
const int = (b: Buffer): Buffer => {
  let x = b;
  while (x.length > 1 && x[0] === 0 && !(x[1]! & 128)) x = x.subarray(1);
  if (x[0]! & 128) x = Buffer.concat([Buffer.from([0]), x]);
  return tlv(0x02, x);
};
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s));
const utc = (d: Date): Buffer =>
  tlv(0x17, Buffer.from(`${d.toISOString().replaceAll(/[-:T]/g, "").slice(2, 14)}Z`));
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.from([0]), b);
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 255 : 0]));
const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const ext = (id: string, critical: boolean, value: Buffer): Buffer =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

interface CertSpec {
  subject: string;
  issuer: string;
  spki: Buffer;
  signKey: crypto.KeyObject;
  ca: boolean;
  dns?: string;
  from: Date;
  to: Date;
}

function certificate(o: CertSpec): Buffer {
  const exts = [
    ext("2.5.29.19", true, seq(...(o.ca ? [bool(true)] : []))), // basicConstraints
    // keyUsage: keyCertSign + cRLSign for a CA, digitalSignature for a leaf
    ext("2.5.29.15", true, bits(Buffer.from([o.ca ? 0x06 : 0x80]))),
  ];
  if (o.dns) exts.push(ext("2.5.29.17", false, seq(tlv(0x82, Buffer.from(o.dns)))));
  if (!o.ca) exts.push(ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1")))); // serverAuth
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(crypto.randomBytes(16)),
    ECDSA_SHA256,
    name(o.issuer),
    seq(utc(o.from), utc(o.to)),
    name(o.subject),
    o.spki,
    tlv(0xa3, seq(...exts)),
  );
  const sig = crypto.sign("sha256", tbs, { key: o.signKey, dsaEncoding: "der" });
  return seq(tbs, ECDSA_SHA256, bits(sig));
}

const pem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END CERTIFICATE-----\n`;

export interface Leaf {
  /** PEM of the leaf private key, for the TLS server socket. */
  key: string;
  /** PEM of the leaf certificate. */
  cert: string;
}

/** The CA of one attempt. The CA private key stays inside this object and is never exported. */
export class JobCa {
  /** PEM of the CA certificate: the one thing given to the sandbox. */
  readonly certPem: string;
  readonly #key: crypto.KeyObject;
  readonly #leafKeyPem: string;
  readonly #leafSpki: Buffer;
  readonly #subject: string;
  readonly #leaves = new Map<string, Leaf>();
  readonly #from: Date;
  readonly #to: Date;

  constructor(o: { label: string; now: number; ttlMs: number }) {
    const ca = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const leaf = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#key = ca.privateKey;
    this.#leafKeyPem = leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    this.#leafSpki = leaf.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    this.#subject = `Turntable job CA ${o.label}`;
    // A little before now (clock skew in the sandbox) and a little after the credential ends.
    this.#from = new Date(o.now - 5 * 60_000);
    this.#to = new Date(o.now + o.ttlMs + 5 * 60_000);
    this.certPem = pem(
      certificate({
        subject: this.#subject,
        issuer: this.#subject,
        spki: ca.publicKey.export({ type: "spki", format: "der" }) as Buffer,
        signKey: ca.privateKey,
        ca: true,
        from: this.#from,
        to: this.#to,
      }),
    );
  }

  /** A server certificate for exactly one hostname, signed by this CA. Cached per host. */
  leafFor(host: string): Leaf {
    const hit = this.#leaves.get(host);
    if (hit) return hit;
    if (!/^[a-z0-9.-]{1,253}$/.test(host)) throw new Error("not a hostname");
    const leaf: Leaf = {
      key: this.#leafKeyPem,
      cert: pem(
        certificate({
          subject: host,
          issuer: this.#subject,
          spki: this.#leafSpki,
          signKey: this.#key,
          ca: false,
          dns: host,
          from: this.#from,
          to: this.#to,
        }),
      ),
    };
    this.#leaves.set(host, leaf);
    return leaf;
  }
}
