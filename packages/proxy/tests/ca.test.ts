import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { JobCa } from "../src/ca";

describe("the per-job CA", () => {
  const now = Date.now();
  const ca = new JobCa({ label: "att1", now, ttlMs: 60_000 });
  const caCert = new crypto.X509Certificate(ca.certPem);

  test("the CA certificate is a self-signed CA", () => {
    expect(caCert.ca).toBe(true);
    expect(caCert.verify(caCert.publicKey)).toBe(true);
    expect(caCert.subject).toContain("Longshore job CA att1");
  });

  test("a leaf is signed by the CA, names exactly one host, and is not a CA", () => {
    const leaf = new crypto.X509Certificate(ca.leafFor("api.example.test").cert);
    expect(leaf.verify(caCert.publicKey)).toBe(true);
    expect(leaf.checkIssued(caCert)).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost("api.example.test")).toBe("api.example.test");
    expect(leaf.checkHost("other.example.test")).toBeUndefined();
    expect(leaf.subjectAltName).toBe("DNS:api.example.test");
  });

  test("validity covers the attempt and ends soon after it", () => {
    expect(Date.parse(caCert.validFrom)).toBeLessThanOrEqual(now);
    expect(Date.parse(caCert.validTo)).toBeGreaterThan(now + 60_000);
    expect(Date.parse(caCert.validTo)).toBeLessThan(now + 60_000 + 10 * 60_000);
  });

  test("two attempts get unrelated CAs, and a leaf of one does not verify under the other", () => {
    const other = new JobCa({ label: "att2", now, ttlMs: 60_000 });
    const otherCa = new crypto.X509Certificate(other.certPem);
    expect(otherCa.publicKey.equals(caCert.publicKey)).toBe(false);
    const leaf = new crypto.X509Certificate(ca.leafFor("api.example.test").cert);
    expect(leaf.verify(otherCa.publicKey)).toBe(false);
  });

  test("leaves are cached per host, and only hostnames are accepted", () => {
    expect(ca.leafFor("a.test")).toBe(ca.leafFor("a.test"));
    expect(() => ca.leafFor("a b")).toThrow();
    expect(() => ca.leafFor("UPPER.test")).toThrow();
  });

  test("the CA's private key is not reachable from its public surface", () => {
    const text = JSON.stringify(Object.getOwnPropertyNames(ca)) + ca.certPem;
    expect(text).not.toContain("PRIVATE KEY");
    expect(Object.keys(ca).filter((k) => /key/i.test(k))).toEqual([]);
  });
});
