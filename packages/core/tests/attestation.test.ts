import { describe, expect, test } from "bun:test";
import { createHash, sign } from "node:crypto";
import {
  AttestationError,
  bundledTrustAnchors,
  verifyAttestation,
  type TrustAnchors,
} from "../src/approvals/attestation";
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
