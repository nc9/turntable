import { describe, expect, test } from "bun:test";
import {
  TURNTABLE_BUILD_TYPE,
  LocalSigner,
  PAYLOAD_TYPE,
  PREDICATE_TYPE,
  type KeyVault,
  buildStatement,
  pae,
  sha256Hex,
  signEnvelope,
  statementBytes,
  verifyArtifact,
  verifyEnvelope,
} from "../src";

const memoryVault = (): KeyVault & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: async (n) => map.get(n), set: async (n, v) => void map.set(n, v) };
};

const artifact = Buffer.from("the release binary");
const input = {
  builderId: "https://ci.example.test/turntable",
  invocationId: "run1",
  repo: "acme/web",
  workflowPath: ".github/workflows/release.yml",
  ref: "refs/tags/v1.2.3",
  sha: "a".repeat(40),
  event: "push",
  inputs: { channel: "stable" },
  actions: [
    { uses: "actions/checkout@v4", repo: "actions/checkout", ref: "v4", sha: "c".repeat(40) },
    { uses: "oven-sh/setup-bun@v2", repo: "oven-sh/setup-bun", ref: "v2", sha: "b".repeat(40) },
    // The same commit named twice is listed once.
    { uses: "actions/checkout@v4", repo: "actions/checkout", ref: "v4", sha: "c".repeat(40) },
  ],
  subjects: [{ name: "turntable-linux-x64", sha256: sha256Hex(artifact) }],
  byproducts: [{ name: "sbom.json", sha256: "d".repeat(64) }],
  startedOn: "2026-11-22T00:00:00.000Z",
  finishedOn: "2026-11-22T00:05:00.000Z",
};

async function signed() {
  const signer = new LocalSigner(memoryVault());
  const key = await signer.ensureKey("release");
  const envelope = await signEnvelope(
    PAYLOAD_TYPE,
    statementBytes(buildStatement(input)),
    signer,
    "release",
  );
  return { signer, key, envelope };
}

describe("the built-in backend", () => {
  test("a key is made once, sealed in the vault, and its private half is never returned", async () => {
    const vault = memoryVault();
    const signer = new LocalSigner(vault);
    const a = await signer.ensureKey("release");
    const b = await signer.ensureKey("release");
    expect(b).toEqual(a);
    expect(vault.map.has("signing/release")).toBe(true);
    expect(JSON.stringify(a)).not.toContain("PRIVATE");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(signer)).toSorted()).toEqual([
      "constructor",
      "ensureKey",
      "publicKey",
      "sign",
    ]);
    expect(a.keyid).toMatch(/^[0-9a-f]{64}$/);
  });

  test("it signs with the named key only; an unknown or malformed key name is refused", async () => {
    const signer = new LocalSigner(memoryVault());
    await signer.ensureKey("release");
    await expect(signer.sign(Buffer.from("x"), "other")).rejects.toThrow("no signing key");
    await expect(signer.sign(Buffer.from("x"), "../etc")).rejects.toThrow();
    expect((await signer.sign(Buffer.from("x"), "release")).length).toBe(64);
  });
});

describe("DSSE envelopes", () => {
  test("an envelope round-trips: it verifies under the key and yields the payload", async () => {
    const { key, envelope } = await signed();
    const v = verifyEnvelope(envelope, key.publicKeyPem);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.keyid).toBe(key.keyid);
      expect(JSON.parse(v.payload.toString())._type).toBe("https://in-toto.io/Statement/v1");
    }
    expect(envelope.signatures[0]!.keyid).toBe(key.keyid);
    expect(envelope.payloadType).toBe(PAYLOAD_TYPE);
  });

  test("the pre-authentication encoding is DSSEv1 with lengths", () => {
    expect(pae("a/b", Buffer.from("hello")).toString()).toBe("DSSEv1 3 a/b 5 hello");
  });

  test("a changed payload, a changed payload type or another key fails verification", async () => {
    const { key, envelope } = await signed();
    const flipped = {
      ...envelope,
      payload: Buffer.from(`${Buffer.from(envelope.payload, "base64")} `).toString("base64"),
    };
    expect(verifyEnvelope(flipped, key.publicKeyPem)).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      verifyEnvelope({ ...envelope, payloadType: "text/plain" }, key.publicKeyPem),
    ).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    const other = await new LocalSigner(memoryVault()).ensureKey("release");
    expect(verifyEnvelope(envelope, other.publicKeyPem)).toMatchObject({
      ok: false,
      reason: "no_signature_for_key",
    });
    expect(verifyEnvelope({ nope: 1 }, key.publicKeyPem)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(verifyEnvelope(envelope, "not a key")).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("a signature a backend gives that does not verify under its own key is refused at signing", async () => {
    const real = new LocalSigner(memoryVault());
    await real.ensureKey("k");
    const liar = {
      publicKey: (r: string) => real.publicKey(r),
      sign: async () => new Uint8Array(64),
    };
    await expect(signEnvelope(PAYLOAD_TYPE, Buffer.from("x"), liar, "k")).rejects.toThrow(
      "does not verify",
    );
  });
});

describe("provenance contents", () => {
  const statement = buildStatement(input);

  test("subjects are the attested artifacts; the predicate is SLSA v1 with Turntable's build type", () => {
    expect(statement.predicateType).toBe(PREDICATE_TYPE);
    expect(statement.subject).toEqual([
      { name: "turntable-linux-x64", digest: { sha256: sha256Hex(artifact) } },
    ]);
    expect(statement.predicate.buildDefinition.buildType).toBe(TURNTABLE_BUILD_TYPE);
    expect(statement.predicate.runDetails.builder.id).toBe("https://ci.example.test/turntable");
    expect(statement.predicate.runDetails.metadata).toEqual({
      invocationId: "run1",
      startedOn: "2026-11-22T00:00:00.000Z",
      finishedOn: "2026-11-22T00:05:00.000Z",
    });
  });

  test("external parameters are the workflow, ref, sha, event and inputs", () => {
    expect(statement.predicate.buildDefinition.externalParameters).toEqual({
      workflow: ".github/workflows/release.yml",
      ref: "refs/tags/v1.2.3",
      sha: "a".repeat(40),
      event: "push",
      inputs: { channel: "stable" },
    });
  });

  test("resolved dependencies are the source commit and each action commit once, in a stable order", () => {
    const deps = statement.predicate.buildDefinition.resolvedDependencies;
    expect(deps[0]).toEqual({
      uri: "git+https://github.com/acme/web@refs/tags/v1.2.3",
      name: "source",
      digest: { gitCommit: "a".repeat(40) },
    });
    expect(deps.slice(1).map((d) => `${d.name}:${d.digest.gitCommit.slice(0, 1)}`)).toEqual([
      "actions/checkout@v4:c",
      "oven-sh/setup-bun@v2:b",
    ]);
    expect(deps[1]!.annotations).toEqual({ ref: "v4" });
  });

  test("other recorded artifacts are byproducts", () => {
    expect(statement.predicate.runDetails.byproducts).toEqual([
      { name: "sbom.json", digest: { sha256: "d".repeat(64) } },
    ]);
  });

  test("the same input always gives the same bytes", () => {
    expect(
      statementBytes(buildStatement(input)).equals(statementBytes(buildStatement(input))),
    ).toBe(true);
  });
});

describe("verifying an artifact", () => {
  test("the artifact, the provenance and the right key verify", async () => {
    const { key, envelope } = await signed();
    const v = verifyArtifact({ artifact, envelope, publicKeyPem: key.publicKeyPem });
    expect(v).toMatchObject({ ok: true, subject: "turntable-linux-x64", keyid: key.keyid });
    expect(
      verifyArtifact({
        artifact,
        envelope,
        publicKeyPem: key.publicKeyPem,
        name: "turntable-linux-x64",
      }).ok,
    ).toBe(true);
  });

  test("a tampered artifact is not a subject of the provenance", async () => {
    const { key, envelope } = await signed();
    const bad = verifyArtifact({
      artifact: Buffer.from("the release binary, modified"),
      envelope,
      publicKeyPem: key.publicKeyPem,
    });
    expect(bad).toEqual({ ok: false, reason: "artifact_not_a_subject" });
    expect(
      verifyArtifact({ artifact, envelope, publicKeyPem: key.publicKeyPem, name: "other-name" }),
    ).toEqual({ ok: false, reason: "artifact_not_a_subject" });
  });

  test("a tampered envelope, the wrong key and a wrong statement type are refused", async () => {
    const { key, envelope } = await signed();
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
    const changed = {
      ...envelope,
      payload: Buffer.from(
        JSON.stringify({
          ...statement,
          subject: [{ name: "x", digest: { sha256: sha256Hex(artifact) } }],
        }),
      ).toString("base64"),
    };
    expect(
      verifyArtifact({ artifact, envelope: changed, publicKeyPem: key.publicKeyPem }),
    ).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    const other = await new LocalSigner(memoryVault()).ensureKey("release");
    expect(verifyArtifact({ artifact, envelope, publicKeyPem: other.publicKeyPem })).toMatchObject({
      ok: false,
    });

    // A genuine signature over something that is not a provenance statement.
    const signer = new LocalSigner(memoryVault());
    const k = await signer.ensureKey("release");
    const text = await signEnvelope("text/plain", Buffer.from("hi"), signer, "release");
    expect(verifyArtifact({ artifact, envelope: text, publicKeyPem: k.publicKeyPem })).toEqual({
      ok: false,
      reason: "wrong_payload_type",
    });
    const wrongType = await signEnvelope(
      PAYLOAD_TYPE,
      Buffer.from(JSON.stringify({ _type: "x", subject: [], predicateType: "other" })),
      signer,
      "release",
    );
    expect(verifyArtifact({ artifact, envelope: wrongType, publicKeyPem: k.publicKeyPem })).toEqual(
      {
        ok: false,
        reason: "wrong_predicate_type",
      },
    );
  });
});
