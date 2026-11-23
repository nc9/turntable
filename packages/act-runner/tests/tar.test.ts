// The in-process tar reader and writer. System tar is the judge here (tests run on dev machines
// and CI, which have it); the code under test runs none.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readTar, readTarGz, tarGzDirectory, writeTar } from "../src/tar";
import { tarDirectory } from "../src/workspace";

const tmp = mkdtempSync(join(tmpdir(), "ls-tar-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("writing", () => {
  test("what it writes is a tar that system tar lists and extracts: files, modes, directories, a symlink, long names", () => {
    const longDir = `${"d".repeat(60)}/${"e".repeat(60)}`;
    const tar = writeTar([
      { path: "a", type: "dir", mode: 0o755 },
      { path: "a/x.txt", type: "file", mode: 0o644, data: new TextEncoder().encode("hello\n") },
      {
        path: "a/run.sh",
        type: "file",
        mode: 0o755,
        data: new TextEncoder().encode("#!/bin/sh\n"),
      },
      { path: "a/l", type: "symlink", mode: 0o777, linkTarget: "x.txt" },
      {
        path: `${longDir}/f.txt`,
        type: "file",
        mode: 0o644,
        data: new TextEncoder().encode("long"),
      },
      { path: "empty", type: "file", mode: 0o600 },
    ]);
    const f = join(tmp, "w.tar");
    writeFileSync(f, tar);
    const listing = execFileSync("tar", ["tf", f], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(listing).toContain("a/x.txt");
    expect(listing).toContain(`${longDir}/f.txt`);
    const out = join(tmp, "w-out");
    mkdirSync(out);
    execFileSync("tar", ["xf", f, "-C", out]);
    expect(readFileSync(join(out, "a/x.txt"), "utf8")).toBe("hello\n");
    expect(statSync(join(out, "a/run.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(out, "a/l"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(out, longDir, "f.txt"), "utf8")).toBe("long");
    expect(statSync(join(out, "empty")).size).toBe(0);
  });

  test("a directory packs recursively, with the entries asked for, and survives a round trip through system tar", async () => {
    const d = join(tmp, "dir");
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "top.txt"), "top");
    writeFileSync(join(d, "sub/in.txt"), "in");
    writeFileSync(join(d, "x.sh"), "echo", { mode: 0o755 });
    symlinkSync("top.txt", join(d, "ln"));
    const all = await tarDirectory(d);
    const out = join(tmp, "dir-out");
    mkdirSync(out);
    const f = join(out, "t.tgz");
    writeFileSync(f, all);
    execFileSync("tar", ["xzf", f, "-C", out]);
    expect(readFileSync(join(out, "sub/in.txt"), "utf8")).toBe("in");
    expect(statSync(join(out, "x.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(out, "ln"), "utf8")).toBe("top");
    // only the named entries
    const some = readTarGz(tarGzDirectory(d, ["sub"]));
    expect(some.map((e) => e.path).toSorted()).toEqual(["sub", "sub/in.txt"]);
  });
});

describe("reading", () => {
  test("reads what system tar writes: gnu and pax, long names, symlinks, hard links, empty files", () => {
    const d = join(tmp, "src");
    const deep = join(d, "x".repeat(80), "y".repeat(80));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "long.txt"), "L");
    writeFileSync(join(d, "a.txt"), "A");
    writeFileSync(join(d, "empty"), "");
    symlinkSync("a.txt", join(d, "sym"));
    execFileSync("ln", [join(d, "a.txt"), join(d, "hard")]);
    for (const fmt of ["gnu", "pax", "ustar"]) {
      const f = join(tmp, `sys-${fmt}.tar.gz`);
      try {
        execFileSync("tar", ["czf", f, `--format=${fmt}`, "-C", d, "."], { stdio: "pipe" });
      } catch {
        continue; // this tar has no such format
      }
      const entries = readTarGz(new Uint8Array(readFileSync(f)));
      const by = Object.fromEntries(entries.map((e) => [e.path.replace(/^\.\//, ""), e]));
      expect(
        new TextDecoder().decode(by[`${"x".repeat(80)}/${"y".repeat(80)}/long.txt`]!.data),
        fmt,
      ).toBe("L");
      // a hard link is stored once with data and once as a link to it, in either order
      const a = by["a.txt"]!;
      const hard = by.hard!;
      const withData = a.type === "file" && a.size > 0 ? a : hard;
      expect(new TextDecoder().decode(withData.data)).toBe("A");
      expect(by.empty!.size).toBe(0);
      expect(by.sym).toMatchObject({ type: "symlink", linkTarget: "a.txt" });
      expect([a.type, hard.type].toSorted()).toEqual(["file", "link"]);
    }
  });

  test("a GitHub-style source tarball is read: one top directory, pax global header ignored", () => {
    const f = join(tmp, "gh");
    mkdirSync(join(f, "repo-abc123/sub"), { recursive: true });
    writeFileSync(join(f, "repo-abc123/action.yml"), "name: a\n");
    writeFileSync(join(f, "repo-abc123/sub/action.yml"), "name: sub\n");
    const entries = readTarGz(tarGzDirectory(f));
    const names = entries.filter((e) => e.type === "file").map((e) => e.path.replace(/^\.\//, ""));
    expect(names.toSorted()).toEqual(["repo-abc123/action.yml", "repo-abc123/sub/action.yml"]);
  });

  test("a corrupt, truncated or oversized archive is an error, not a partial read", () => {
    const good = writeTar([{ path: "a", type: "file", mode: 0o644, data: new Uint8Array(1000) }]);
    expect(() => readTar(good.subarray(0, 700))).toThrow(/truncated/);
    const bad = good.slice();
    bad[10] = bad[10]! ^ 0xff;
    expect(() => readTar(bad)).toThrow(/checksum/);
    expect(() => readTarGz(new Uint8Array([1, 2, 3]))).toThrow(/decompress/);
    expect(() => readTar(good, { maxBytes: 100 })).toThrow(/too large/);
    // a bomb: gunzip is capped by maxBytes
    const bomb = gzipSync(new Uint8Array(5_000_000));
    expect(() => readTarGz(bomb, { maxBytes: 1_000_000 })).toThrow();
    const many = writeTar(
      Array.from({ length: 10 }, (_, i) => ({ path: `f${i}`, type: "file" as const, mode: 0o644 })),
    );
    expect(() => readTar(many, { maxEntries: 5 })).toThrow(/too many/);
  });
});
