import { expect, test } from "bun:test";
import { b64urlDecode, b64urlEncode, createPasskey, signWithPasskey } from "../src/lib/webauthn";

const buf = (...n: number[]) => new Uint8Array(n).buffer;

test("base64url round-trips and has no padding or unsafe characters", () => {
  const bytes = new Uint8Array([251, 255, 254, 0, 1, 2, 3]);
  const text = b64urlEncode(bytes);
  expect(text).not.toMatch(/[+/=]/);
  expect([...b64urlDecode(text)]).toEqual([...bytes]);
  expect(b64urlEncode(new Uint8Array(0))).toBe("");
});

test("signing asks for the issued challenge with user verification, and shapes the assertion", async () => {
  let seen: PublicKeyCredentialRequestOptions | undefined;
  const sig = await signWithPasskey(
    {
      challenge: b64urlEncode(buf(1, 2, 3)),
      rpId: "ci.example.com",
      passkeyId: b64urlEncode(buf(9, 9)),
    },
    {
      create: async () => null,
      get: async (o) => {
        seen = o?.publicKey;
        return {
          rawId: buf(9, 9),
          response: {
            clientDataJSON: buf(1),
            authenticatorData: buf(2),
            signature: buf(3),
          },
        } as unknown as Credential;
      },
    },
  );
  expect([...new Uint8Array(seen!.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
  expect(seen!.rpId).toBe("ci.example.com");
  expect(seen!.userVerification).toBe("required");
  expect(seen!.allowCredentials).toHaveLength(1);
  expect(sig).toEqual({
    kind: "webauthn",
    credential_id: b64urlEncode(buf(9, 9)),
    client_data_json: b64urlEncode(buf(1)),
    authenticator_data: b64urlEncode(buf(2)),
    signature: b64urlEncode(buf(3)),
  });
});

test("a cancelled ceremony is a plain message, not a raw DOM error", async () => {
  const cancelled = {
    create: async () => {
      throw new DOMException("x", "NotAllowedError");
    },
    get: async () => {
      throw new DOMException("x", "NotAllowedError");
    },
  };
  await expect(
    signWithPasskey({ challenge: "AQID", rpId: "h", passkeyId: "AQID" }, cancelled),
  ).rejects.toThrow(/cancelled or timed out/);
  await expect(
    createPasskey({ challenge: "AQID", rpId: "h", person: "a" }, cancelled),
  ).rejects.toThrow(/cancelled or timed out/);
});

test("registration asks for attestation none, ES256 and EdDSA, and user verification", async () => {
  let seen: PublicKeyCredentialCreationOptions | undefined;
  const out = await createPasskey(
    { challenge: "AQID", rpId: "ci.example.com", person: "alice" },
    {
      get: async () => null,
      create: async (o) => {
        seen = o?.publicKey;
        return {
          response: { clientDataJSON: buf(4), attestationObject: buf(5) },
        } as unknown as Credential;
      },
    },
  );
  expect(seen!.attestation).toBe("none");
  expect(seen!.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8]);
  expect(seen!.authenticatorSelection?.userVerification).toBe("required");
  expect(seen!.rp).toEqual({ id: "ci.example.com", name: "Longshore" });
  expect(out).toEqual({
    clientDataJson: b64urlEncode(buf(4)),
    attestationObject: b64urlEncode(buf(5)),
  });
});
