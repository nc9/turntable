import { describe, expect, test } from "bun:test";
import { createHash, sign } from "node:crypto";
import {
  AttestationError,
  bundledTrustAnchors,
  verifyAttestation,
  type TrustAnchors,
} from "../src/approvals/attestation";
import { parseCertInfo } from "../src/approvals/x509-info";
import { allowedAaguids, keyPolicyViolation } from "../src/approvals/key-policy";
import { AAGUID_PRESETS } from "../src/approvals/vendor-roots";
import { makeCert, type TestCert } from "./helpers/x509";

const AAGUID = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const AAGUID_TEXT = "00112233-4455-6677-8899-aabbccddeeff";
const clientHash = createHash("sha256").update("client").digest();
const authData = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x45]), Buffer.alloc(4), AAGUID]);

const root = makeCert({ cn: "R", ca: true });
const inter = makeCert({ cn: "I", issuer: { cn: "R", key: root.key }, ca: true });
const anchors: TrustAnchors = { roots: [root.cert], intermediates: [] };

function statement(leaf: TestCert, o: { chain?: TestCert[]; fmt?: string; noX5c?: boolean } = {}) {
  const sig = sign("sha256", Buffer.concat([authData, clientHash]), leaf.key);
  const stmt = new Map<string, unknown>([
    ["alg", -7],
    ["sig", new Uint8Array(sig)],
  ]);
  if (!o.noX5c)
    stmt.set(
      "x5c",
      [leaf, ...(o.chain ?? [])].map((c) => new Uint8Array(c.der)),
    );
  return new Map<any, any>([
    ["fmt", o.fmt ?? "packed"],
    ["attStmt", stmt],
  ]);
}
const run = (att: Map<any, any>, a: TrustAnchors = anchors, now?: number) =>
  verifyAttestation(att, authData, clientHash, { anchors: a, ...(now ? { now } : {}) });

describe("packed attestation", () => {
  const leafFor = (issuer: TestCert, cn: string, ca = false, aaguid: Buffer | null = AAGUID) =>
    makeCert({
      cn,
      issuer: { cn: issuer === root ? "R" : "I", key: issuer.key },
      ca,
      ...(aaguid ? { aaguid } : {}),
    });

  test("a chain to a pinned root verifies, directly and through an intermediate the device sends", () => {
    expect(run(statement(leafFor(root, "L")))).toEqual({
      fmt: "packed",
      aaguid: AAGUID_TEXT,
      verified: true,
    });
    expect(run(statement(leafFor(inter, "L"), { chain: [inter] })).verified).toBe(true);
  });

  test("a chain that needs an intermediate nobody supplied is unverified, not trusted", () => {
    expect(run(statement(leafFor(inter, "L"))).verified).toBe(false);
  });

  test("none, self attestation, an untrusted root and an expired leaf are all unverified", () => {
    expect(run(new Map<any, any>([["fmt", "none"]])).verified).toBe(false);
    expect(run(statement(leafFor(root, "L"), { noX5c: true })).verified).toBe(false);
    const other = makeCert({ cn: "R", ca: true }); // same name, different key
    expect(run(statement(leafFor(other, "L"))).verified).toBe(false);
    const old = makeCert({
      cn: "L",
      issuer: { cn: "R", key: root.key },
      ca: false,
      aaguid: AAGUID,
      notBefore: new Date(Date.now() - 10 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
    });
    expect(run(statement(old)).verified).toBe(false);
  });

  test("a leaf without the AAGUID extension binds nothing: not verified", () => {
    expect(run(statement(leafFor(root, "L", false, null))).verified).toBe(false);
  });

  test("the AAGUID is read only from its own extension, which must not be critical", () => {
    // The OID's bytes sit inside another extension's value: not an AAGUID.
    const oidBytes = Buffer.from("060b2b06010401" + "82e51c" + "010104", "hex");
    const decoy = makeCert({
      cn: "L",
      issuer: { cn: "R", key: root.key },
      ca: false,
      decoy: Buffer.concat([oidBytes, Buffer.from([0x04, 0x12, 0x04, 0x10]), AAGUID]),
    });
    expect(run(statement(decoy)).verified).toBe(false);
    // A critical AAGUID extension is refused.
    const critical = makeCert({
      cn: "L",
      issuer: { cn: "R", key: root.key },
      ca: false,
      aaguid: AAGUID,
      aaguidCritical: true,
    });
    expect(() => run(statement(critical))).toThrow(/must not be critical/);
  });

  test("the leaf must be v3, carry OU=Authenticator Attestation, and not be a CA", () => {
    const base = { cn: "L", issuer: { cn: "R", key: root.key }, aaguid: AAGUID };
    expect(() => run(statement(makeCert({ ...base, ca: true })))).toThrow(/must not be a CA/);
    expect(() => run(statement(makeCert({ ...base, ca: false, version: 1 })))).toThrow(
      /v3|valid DER/,
    );
    expect(parseCertInfo(makeCert({ ...base, ca: false, version: 1 }).der).version).toBe(1);
    expect(() => run(statement(makeCert({ ...base, ca: false, ou: null })))).toThrow(/OU=/);
    expect(() => run(statement(makeCert({ ...base, ca: false, ou: "Something else" })))).toThrow(
      /OU=/,
    );
  });

  test("an intermediate must be a CA and respect its pathLen", () => {
    const mk = (pathLen: number | undefined) =>
      makeCert({
        cn: "I",
        issuer: { cn: "R", key: root.key },
        ca: true,
        ...(pathLen === undefined ? {} : { pathLen }),
      });
    const leafUnder = (i: TestCert) =>
      makeCert({ cn: "L", issuer: { cn: "I", key: i.key }, ca: false, aaguid: AAGUID });
    // pathLen 0 allows no CA below it: a leaf directly under it is fine.
    const i0 = mk(0);
    expect(run(statement(leafUnder(i0), { chain: [i0] })).verified).toBe(true);
    // A second intermediate under a pathLen-0 one is refused; under an unconstrained one it is fine.
    const sub = (parent: TestCert) =>
      makeCert({ cn: "I", issuer: { cn: "I", key: parent.key }, ca: true });
    const s0 = sub(i0);
    expect(run(statement(leafUnder(s0), { chain: [s0, i0] })).verified).toBe(false);
    const ii = mk(undefined);
    const s1 = sub(ii);
    expect(run(statement(leafUnder(s1), { chain: [s1, ii] })).verified).toBe(true);
    // A non-CA certificate used as an issuer is not accepted.
    const notCa = makeCert({ cn: "I", issuer: { cn: "R", key: root.key }, ca: false });
    const l2 = makeCert({
      cn: "L",
      issuer: { cn: "I", key: notCa.key },
      ca: false,
      aaguid: AAGUID,
    });
    expect(run(statement(l2, { chain: [notCa] })).verified).toBe(false);
  });

  test("a bad signature, a CA leaf, a mismatched AAGUID, other formats and ECDAA are refused", () => {
    const att = statement(leafFor(root, "L"));
    (att.get("attStmt") as Map<string, Uint8Array>).get("sig")![5]! ^= 1;
    expect(() => run(att)).toThrow(AttestationError);
    expect(() => run(statement(leafFor(root, "L", true)))).toThrow(/must not be a CA/);
    expect(() => run(statement(leafFor(root, "L", false, Buffer.alloc(16, 9))))).toThrow(/AAGUID/);
    expect(() => run(statement(leafFor(root, "L"), { fmt: "tpm" }))).toThrow(/not supported/);
    const ecdaa = statement(leafFor(root, "L"));
    (ecdaa.get("attStmt") as Map<string, unknown>).set("ecdaaKeyId", new Uint8Array(4));
    expect(() => run(ecdaa)).toThrow(/ECDAA/);
  });
});

describe("pinned vendor material", () => {
  test("the bundled roots and intermediates parse, and each intermediate is issued by a root", () => {
    const a = bundledTrustAnchors();
    expect(a.roots).toHaveLength(3);
    expect(a.roots.every((r) => r.ca)).toBe(true);
    for (const i of a.intermediates)
      expect(a.roots.some((r) => i.checkIssued(r) && i.verify(r.publicKey))).toBe(true);
    expect(a.roots.map((r) => r.subject).join("|")).toContain("Yubico");
  });

  test("the yubikey preset is a list of well-formed AAGUIDs and includes the YubiKey 5 series", () => {
    const list = AAGUID_PRESETS.yubikey!;
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((a) => /^[0-9a-f-]{36}$/.test(a))).toBe(true);
    expect(allowedAaguids({ mode: "hardware", presets: ["yubikey"], aaguids: [] }).size).toBe(
      list.length,
    );
  });

  test("policy decisions", () => {
    const hw = { mode: "hardware" as const, presets: [], aaguids: [AAGUID_TEXT] };
    const any = { mode: "any" as const, presets: [], aaguids: [] };
    const good = { kind: "webauthn", attested: true, aaguid: AAGUID_TEXT };
    expect(keyPolicyViolation(hw, good)).toBeNull();
    expect(keyPolicyViolation(hw, { ...good, attested: false })).toContain("attestation");
    expect(keyPolicyViolation(hw, { ...good, aaguid: "x" })).toContain("allowlist");
    expect(keyPolicyViolation(hw, { kind: "ed25519" })).toContain("offline");
    expect(keyPolicyViolation(any, { kind: "ed25519" })).toBeNull();
  });
});
