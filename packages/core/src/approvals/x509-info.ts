// A minimal DER walker for what packed attestation needs from a certificate: the version, the
// subject's organizational units, and the extensions (OID, critical flag, value). It reads the
// structure, never searches raw bytes, so an OID that merely appears inside some other field is
// not mistaken for an extension. No dependency: node's X509Certificate does not expose these.

type Tlv = { tag: number; start: number; end: number };

function tlv(b: Buffer, pos: number, limit: number): Tlv {
  if (pos + 2 > limit) throw new Error("truncated DER");
  const tag = b[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("unsupported DER tag");
  let len = b[pos + 1]!;
  let at = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || at + n > limit) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[at++]!;
  }
  if (at + len > limit) throw new Error("DER length exceeds its container");
  return { tag, start: at, end: at + len };
}

/** The children of a constructed element. */
function children(b: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end;) {
    const c = tlv(b, p, t.end);
    out.push(c);
    p = c.end;
  }
  return out;
}

function oidOf(b: Buffer, t: Tlv): string {
  if (t.tag !== 0x06) throw new Error("expected an OID");
  const parts: number[] = [];
  let v = 0;
  const bytes = b.subarray(t.start, t.end);
  for (let i = 0; i < bytes.length; i++) {
    v = v * 128 + (bytes[i]! & 0x7f);
    if ((bytes[i]! & 0x80) === 0) {
      if (parts.length === 0)
        parts.push(Math.min(2, Math.floor(v / 40)), v - 40 * Math.min(2, Math.floor(v / 40)));
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

export type CertInfo = {
  /** 1, 2 or 3. */
  version: number;
  /** Values of the subject's organizationalUnitName (2.5.4.11) attributes. */
  subjectOu: string[];
  extensions: Map<string, { critical: boolean; value: Buffer }>;
};

export const OID_BASIC_CONSTRAINTS = "2.5.29.19";
export const OID_FIDO_AAGUID = "1.3.6.1.4.1.45724.1.1.4";

/** Parses a certificate's version, subject OUs and extensions. Throws on malformed DER. */
export function parseCertInfo(der: Buffer): CertInfo {
  const cert = tlv(der, 0, der.length);
  if (cert.tag !== 0x30) throw new Error("not a certificate");
  const tbs = children(der, cert)[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("no TBS certificate");
  const f = children(der, tbs);
  let i = 0;
  let version = 1;
  if (f[i]?.tag === 0xa0) {
    const v = children(der, f[i]!)[0];
    if (!v || v.tag !== 0x02) throw new Error("bad version");
    version = der[v.start]! + 1;
    i++;
  }
  // serial, signature algorithm, issuer, validity, subject, subjectPublicKeyInfo
  const subject = f[i + 4];
  if (!subject || subject.tag !== 0x30) throw new Error("no subject");
  const subjectOu: string[] = [];
  for (const rdn of children(der, subject)) {
    for (const atv of children(der, rdn)) {
      const [o, v] = children(der, atv);
      if (o && v && oidOf(der, o) === "2.5.4.11")
        subjectOu.push(der.subarray(v.start, v.end).toString("utf8"));
    }
  }
  const extensions = new Map<string, { critical: boolean; value: Buffer }>();
  const extWrap = f.slice(i + 6).find((t) => t.tag === 0xa3);
  if (extWrap) {
    const seq = children(der, extWrap)[0];
    if (!seq || seq.tag !== 0x30) throw new Error("bad extensions");
    for (const e of children(der, seq)) {
      const parts = children(der, e);
      const oid = oidOf(der, parts[0]!);
      let k = 1;
      let critical = false;
      if (parts[k]?.tag === 0x01) {
        critical = der[parts[k]!.start] !== 0;
        k++;
      }
      const val = parts[k];
      if (!val || val.tag !== 0x04 || k !== parts.length - 1) throw new Error("bad extension");
      if (extensions.has(oid)) throw new Error("duplicate extension");
      extensions.set(oid, { critical, value: der.subarray(val.start, val.end) });
    }
  }
  return { version, subjectOu, extensions };
}

/** basicConstraints: whether it is a CA and its pathLenConstraint; null when absent. */
export function basicConstraints(info: CertInfo): { ca: boolean; pathLen?: number } | null {
  const e = info.extensions.get(OID_BASIC_CONSTRAINTS);
  if (!e) return null;
  const seq = tlv(e.value, 0, e.value.length);
  if (seq.tag !== 0x30) throw new Error("bad basicConstraints");
  let ca = false;
  let pathLen: number | undefined;
  for (const c of children(e.value, seq)) {
    if (c.tag === 0x01) ca = e.value[c.start] !== 0;
    else if (c.tag === 0x02) pathLen = e.value[c.end - 1];
  }
  return { ca, ...(pathLen === undefined ? {} : { pathLen }) };
}

/** The 16 AAGUID bytes from the FIDO AAGUID extension; null when absent; throws if critical or malformed. */
export function fidoAaguid(info: CertInfo): Buffer | null {
  const e = info.extensions.get(OID_FIDO_AAGUID);
  if (!e) return null;
  if (e.critical) throw new Error("the AAGUID extension must not be critical");
  const inner = tlv(e.value, 0, e.value.length);
  if (inner.tag !== 0x04 || inner.end !== e.value.length || inner.end - inner.start !== 16)
    throw new Error("malformed AAGUID extension");
  return Buffer.from(e.value.subarray(inner.start, inner.end));
}
