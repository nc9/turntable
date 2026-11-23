import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { binariesIn, dryRunProvenance } from "./dry-run-provenance";

const tmp = mkdtempSync(join(tmpdir(), "ls-dryrun-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function dist(): string {
  const d = mkdtempSync(join(tmp, "d-"));
  const files: Record<string, Buffer> = {
    "longshore-linux-x64": Buffer.from("linux binary bytes"),
    "longshore-darwin-arm64": Buffer.from("darwin binary bytes"),
  };
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
  const sums =
    Object.entries(files)
      .map(([n, b]) => `${hex(b)}  ${n}`)
      .join("\n") + `\n${"a".repeat(64)}  longshore-0.1.0.cdx.json\n`;
  writeFileSync(join(d, "SHA256SUMS"), sums);
  return d;
}

const args = (d: string, out: string) => ({
  dist: d,
  out,
  version: "v0.0.0-dryrun",
  repo: "acme/longshore",
  sha: "b".repeat(40),
  ref: "refs/heads/main",
});

describe("release dry-run provenance", () => {
  test("lists the binaries in SHA256SUMS and nothing else", () => {
    const d = dist();
    expect(binariesIn(readFileSync(join(d, "SHA256SUMS"), "utf8")).map((a) => a.name)).toEqual([
      "longshore-linux-x64",
      "longshore-darwin-arm64",
    ]);
    expect(binariesIn("")).toEqual([]);
    expect(binariesIn(`${"a".repeat(64)}  evil/../../longshore-linux-x64\n`)).toEqual([]);
  });

  test("signs a statement for every binary, verifies each, and a changed binary is refused", async () => {
    const d = dist();
    const out = join(tmp, "out-1");
    const r = await dryRunProvenance(args(d, out));
    expect(r.verified).toEqual(["longshore-linux-x64", "longshore-darwin-arm64"]);
    expect(r.tamperRefused).toBe(true);
    const env = JSON.parse(readFileSync(join(out, "provenance.dry-run.intoto.json"), "utf8"));
    expect(env.payloadType).toBe("application/vnd.in-toto+json");
    expect(readFileSync(join(out, "dry-run-public-key.pem"), "utf8")).toContain("PUBLIC KEY");
    // No private key is written anywhere.
    for (const f of ["provenance.dry-run.intoto.json", "dry-run-public-key.pem"]) {
      expect(readFileSync(join(out, f), "utf8")).not.toContain("PRIVATE");
    }
  });

  test("a binary that does not match SHA256SUMS fails the dry run", async () => {
    const d = dist();
    writeFileSync(join(d, "longshore-linux-x64"), "someone changed this");
    await expect(dryRunProvenance(args(d, join(tmp, "out-2")))).rejects.toThrow(
      /does not match SHA256SUMS/,
    );
  });

  test("an empty or binary-less SHA256SUMS fails", async () => {
    const d = mkdtempSync(join(tmp, "e-"));
    mkdirSync(join(d, "x"));
    writeFileSync(join(d, "SHA256SUMS"), `${"a".repeat(64)}  longshore-0.1.0.cdx.json\n`);
    await expect(dryRunProvenance(args(d, join(tmp, "out-3")))).rejects.toThrow(/no binaries/);
  });
});
