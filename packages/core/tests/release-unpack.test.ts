import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  looksLikeZip,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  unpackZip,
  UnpackError,
  type UnpackCode,
} from "../src/release/unpack";
import { buildZip, type ZipEntry } from "./helpers/zip-builder";

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tt-unpack-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

async function refused(
  entries: readonly ZipEntry[],
  code: UnpackCode,
  limits = {},
): Promise<string> {
  const dest = fresh();
  const err = await unpackZip(buildZip(entries), dest, limits).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnpackError);
  expect((err as UnpackError).code).toBe(code);
  return dest;
}

describe("unpackZip", () => {
  test("a good zip yields each file's name and sha256 and writes them under the directory", async () => {
    const dest = fresh();
    const files = await unpackZip(
      buildZip([
        { name: "bin/", mode: 0o040755 },
        { name: "bin/turntable-linux-x64", data: "ELF-one" },
        { name: "turntable-darwin-arm64", data: "MACH-two", method: 0 },
        { name: "empty.txt", data: "" },
      ]),
      dest,
    );
    expect(files).toEqual([
      { name: "bin/turntable-linux-x64", size: 7, sha256: sha("ELF-one") },
      { name: "empty.txt", size: 0, sha256: sha("") },
      { name: "turntable-darwin-arm64", size: 8, sha256: sha("MACH-two") },
    ]);
    expect(readFileSync(join(dest, "bin/turntable-linux-x64"), "utf8")).toBe("ELF-one");
    expect(lstatSync(join(dest, "bin/turntable-linux-x64")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dest).toSorted()).toEqual(["bin", "empty.txt", "turntable-darwin-arm64"]);
  });

  test("looksLikeZip tells a zip from a raw binary", () => {
    expect(looksLikeZip(buildZip([{ name: "a", data: "x" }]))).toBe(true);
    expect(looksLikeZip(buildZip([]))).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode("\x7fELF...."))).toBe(false);
    expect(looksLikeZip(new Uint8Array())).toBe(false);
  });

  for (const name of [
    "/etc/passwd",
    "../evil",
    "a/../../evil",
    "a/./b",
    "a//b",
    "..",
    "C:/win",
    "a\\b",
    "with space",
    ".hidden-first",
    "nul\0byte",
  ]) {
    test(`refuses the path ${JSON.stringify(name)}`, async () => {
      const dest = await refused([{ name, data: "x" }], "unsafe_path");
      expect(readdirSync(dest)).toEqual([]);
    });
  }

  test("refuses a symlink, even one that points inside", async () => {
    const dest = await refused(
      [
        { name: "ok", data: "fine" },
        { name: "link", data: "ok", mode: 0o120777 },
      ],
      "link",
    );
    // Nothing is written once the directory is found unsafe.
    expect(readdirSync(dest)).toEqual([]);
  });

  test("refuses a symlink from a non-Unix host and a Windows reparse point", async () => {
    await refused([{ name: "l", data: "x", mode: 0o120777, host: 0 }], "link");
    await refused([{ name: "r", data: "x", mode: 0, host: 0, dosAttrs: 0x400 }], "link");
  });

  for (const [what, mode] of [
    ["a character device", 0o020644],
    ["a block device", 0o060644],
    ["a fifo", 0o010644],
    ["a socket", 0o140644],
  ] as const) {
    test(`refuses ${what}`, async () => {
      await refused([{ name: "dev", data: "", mode }], "special_file");
    });
  }

  test("refuses a duplicate name, also when only the case differs", async () => {
    await refused(
      [
        { name: "a", data: "1" },
        { name: "a", data: "2" },
      ],
      "duplicate",
    );
    await refused(
      [
        { name: "Tool", data: "1" },
        { name: "tool", data: "2" },
      ],
      "duplicate",
    );
  });

  test("refuses a name that is a file and a directory", async () => {
    await refused(
      [
        { name: "a", data: "1" },
        { name: "a/b", data: "2" },
      ],
      "path_conflict",
    );
  });

  test("caps the file count", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, data: "x" }));
    await refused(many, "too_many_files", { maxFiles: 3 });
    expect(MAX_FILES).toBeGreaterThan(1000);
    // The default cap holds too: one over it is refused before anything is read.
    const over = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}`, data: "" }));
    await refused(over, "too_many_files");
  });

  test("caps the total uncompressed size, from the declared sizes", async () => {
    await refused(
      [
        { name: "a", data: "x".repeat(60) },
        { name: "b", data: "y".repeat(60) },
      ],
      "too_large",
      { maxTotalBytes: 100 },
    );
    expect(MAX_TOTAL_BYTES).toBe(2 * 1024 ** 3);
  });

  test("a zip that inflates past the size it declared is refused (a bomb stops at its claim)", async () => {
    const dest = fresh();
    const err = await unpackZip(
      buildZip([{ name: "bomb", data: "0".repeat(100_000), declaredSize: 10 }]),
      dest,
      { maxTotalBytes: 1000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnpackError);
    expect((err as UnpackError).code).toBe("corrupt");
    expect(readdirSync(dest)).toEqual([]);
  });

  test("refuses a bad CRC, a local header naming another file, and an encrypted entry", async () => {
    await refused([{ name: "a", data: "x", crc: 1 }], "corrupt");
    await refused([{ name: "a", data: "x", localName: "b" }], "corrupt");
    await refused([{ name: "a", data: "x", flags: 1 }], "unsupported");
  });

  test("refuses bytes that are not a zip, and trailing bytes after the end record", async () => {
    const dest = fresh();
    await expect(
      unpackZip(new TextEncoder().encode("not a zip at all, nothing"), dest),
    ).rejects.toBeInstanceOf(UnpackError);
    const z = buildZip([{ name: "a", data: "x" }]);
    const padded = new Uint8Array(z.length + 3);
    padded.set(z);
    await expect(unpackZip(padded, fresh())).rejects.toBeInstanceOf(UnpackError);
  });

  test("a hostile name never writes outside the directory", async () => {
    const root = fresh();
    const dest = join(root, "inner");
    await expect(
      unpackZip(buildZip([{ name: "../escaped", data: "x" }]), dest),
    ).rejects.toBeInstanceOf(UnpackError);
    expect(readdirSync(root)).toEqual([]);
  });
});
