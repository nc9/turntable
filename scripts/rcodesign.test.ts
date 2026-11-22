import { describe, expect, test } from "bun:test";
import { RCODESIGN_ASSETS, parseSignatureInfo } from "./rcodesign";

const info = (flags: string): string => `- path: x
  file_sha256: abc
  entity:
    mach_o:
      signature:
        code_directory:
          version: '0x20400'
          flags: ${flags}
          identifier: turntable-darwin-arm64
          digest_type: sha256
`;

describe("parseSignatureInfo", () => {
  test("reads flags, identifier, digest type and file hash", () => {
    expect(parseSignatureInfo(info("CodeSignatureFlags(ADHOC)"))).toEqual({
      flags: "CodeSignatureFlags(ADHOC)",
      identifier: "turntable-darwin-arm64",
      digestType: "sha256",
      fileSha256: "abc",
    });
  });
  test("a missing field fails loudly", () => {
    expect(() => parseSignatureInfo("nothing here")).toThrow(/no code directory flags/);
  });
});

describe("pinned rcodesign", () => {
  test("every asset has a sha256 and a versioned name", () => {
    for (const a of Object.values(RCODESIGN_ASSETS)) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.asset).toContain("0.29.0");
    }
  });
});
