// SigV4 against AWS's published signature-v4 test suite (the `get-vanilla` style cases).
import { describe, expect, test } from "bun:test";
import { signV4 } from "../src";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const base = {
  region: "us-east-1",
  service: "service",
  credentials,
  amzDate: "20150830T123600Z",
};
const auth = (sig: string, headers = "host;x-amz-date"): string =>
  `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${headers}, Signature=${sig}`;

describe("SigV4 test vectors", () => {
  test("get-vanilla", () => {
    const h = signV4({ ...base, method: "GET", headers: { host: "example.amazonaws.com" } });
    expect(h.authorization).toBe(
      auth("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"),
    );
  });

  test("get-vanilla-query-order-key-case sorts the query", () => {
    const h = signV4({
      ...base,
      method: "GET",
      headers: { host: "example.amazonaws.com" },
      query: [
        ["Param2", "value2"],
        ["Param1", "value1"],
      ],
    });
    expect(h.authorization).toBe(
      auth("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"),
    );
  });

  test("post-vanilla", () => {
    const h = signV4({ ...base, method: "POST", headers: { host: "example.amazonaws.com" } });
    expect(h.authorization).toBe(
      auth("5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"),
    );
  });

  test("a session token is signed as a header", () => {
    const h = signV4({
      ...base,
      method: "GET",
      headers: { host: "example.amazonaws.com" },
      credentials: { ...credentials, sessionToken: "tok" },
    });
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });
});
