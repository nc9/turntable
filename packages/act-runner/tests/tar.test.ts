// The in-process tar reader and writer. System tar is the judge here (tests run on dev machines
// and CI, which have it); the code under test runs none.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { readTar, readTarGz, tarGzDirectory, tarGzDirectoryToFile, writeTar } from "../src/tar";
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

describe("hardening", () => {
  test("pax records are a Map: a record named __proto__ or constructor changes nothing", () => {
    const rec = (k: string, v: string): string => {
      const rest = ` ${k}=${v}\n`;
      let len = rest.length + 1;
      while (`${len}${rest}`.length !== len) len = `${len}${rest}`.length;
      return `${len}${rest}`;
    };
    const body = new TextEncoder().encode(
      rec("__proto__", "polluted") + rec("constructor", "x") + rec("path", "renamed.txt"),
    );
    const entry = writeTar([
      { path: "orig.txt", type: "file", mode: 0o644, data: new TextEncoder().encode("hi") },
    ]);
    // a pax header in front of the entry
    const pax = writeTar([{ path: "PaxHeader", type: "file", mode: 0o644, data: body }]).subarray(
      0,
      512 + Math.ceil(body.length / 512) * 512,
    );
    pax[156] = "x".charCodeAt(0);
    // fix the checksum after changing the type
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : pax[i]!;
    pax.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const all = new Uint8Array([...pax, ...entry]);
    const got = readTar(all);
    expect(got.map((e) => e.path)).toEqual(["renamed.txt"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  test("the writer keeps permission bits only (0o777), and refuses a number that does not fit its field", () => {
    const tar = writeTar([{ path: "f", type: "file", mode: 0o4755, data: new Uint8Array(1) }]);
    expect(readTar(tar)[0]!.mode).toBe(0o755); // setuid is gone
    expect(() => writeTar([{ path: "f", type: "file", mode: 0o644, mtime: 2 ** 40 }])).toThrow(
      /does not fit/,
    );
    expect(() => writeTar([{ path: "f", type: "file", mode: 0o644, mtime: Number.NaN }])).toThrow(
      /integer/,
    );
  });

  test("a directory streams to a file as ONE gzip member that every reader takes whole: node zlib, Bun, system tar and the reader", async () => {
    const d = join(tmp, "stream");
    mkdirSync(join(d, "sub"), { recursive: true });
    for (let i = 0; i < 40; i += 1)
      writeFileSync(join(d, `sub/f${i}.txt`), `file ${i}\n`.repeat(2000));
    symlinkSync("sub/f1.txt", join(d, "ln"));
    // a link whose target bytes are not UTF-8 is kept as it is
    symlinkSync(Buffer.from([0x74, 0xff, 0xfe, 0x74]), join(d, "raw"));
    const out = join(tmp, "stream.tgz");
    const r = await tarGzDirectoryToFile(d, out, { maxBytes: 10_000_000 });
    expect(r.entries).toBe(44); // ".", sub, 40 files, two symlinks
    const bytes = new Uint8Array(readFileSync(out));
    // one member: the gzip magic with the deflate method is not found again after the header
    let members = 0;
    for (let i = 0; i + 2 < bytes.length; i += 1)
      if (bytes[i] === 0x1f && bytes[i + 1] === 0x8b && bytes[i + 2] === 8) members += 1;
    expect(members).toBe(1);
    const viaNode = gunzipSync(bytes);
    const viaBun = Bun.gunzipSync(bytes);
    expect(viaBun.length).toBe(viaNode.length);
    expect(Buffer.from(viaBun).equals(viaNode)).toBe(true);
    const read = readTarGz(bytes);
    expect(read.filter((e) => e.type === "file")).toHaveLength(40);
    expect(read.find((e) => e.path === "ln")!.linkTarget).toBe("sub/f1.txt");
    const x = join(tmp, "stream-x");
    mkdirSync(x);
    execFileSync("tar", ["xzf", out, "-C", x]);
    expect(readFileSync(join(x, "sub/f39.txt"), "utf8")).toBe("file 39\n".repeat(2000));
    expect(readlinkSync(join(x, "raw"), { encoding: "buffer" })).toEqual(
      Buffer.from([0x74, 0xff, 0xfe, 0x74]),
    );
  });

  test("the file is created exclusively, the size cap removes it, and the checkpoint runs between entries", async () => {
    const d = join(tmp, "stream2");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "a"), "x".repeat(100_000));
    const exists = join(tmp, "exists.tgz");
    writeFileSync(exists, "mine");
    await expect(tarGzDirectoryToFile(d, exists, { maxBytes: 1e6 })).rejects.toThrow(
      /EEXIST|exists/i,
    );
    expect(readFileSync(exists, "utf8")).toBe("mine");
    const link = join(tmp, "link.tgz");
    symlinkSync(join(tmp, "victim"), link);
    await expect(tarGzDirectoryToFile(d, link, { maxBytes: 1e6 })).rejects.toThrow();
    expect(() => statSync(join(tmp, "victim"))).toThrow();
    const cap = join(tmp, "cap.tgz");
    writeFileSync(
      join(d, "noise"),
      new Uint8Array(200_000).map((_, i) => (i * 7919) % 251),
    );
    await expect(tarGzDirectoryToFile(d, cap, { maxBytes: 100 })).rejects.toThrow(
      /larger than the cap/,
    );
    expect(() => statSync(cap)).toThrow(); // removed
    let calls = 0;
    await tarGzDirectoryToFile(d, join(tmp, "cp.tgz"), {
      maxBytes: 1e7,
      checkpoint: () => void (calls += 1),
    });
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("a file that vanishes while the directory is being packed", () => {
  /** A repo-like tree: `.git/objects/maintenance.lock` is what a background `git gc` makes and removes. */
  function tree(name: string): string {
    const d = join(tmp, name);
    mkdirSync(join(d, ".git", "objects"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(d, ".git", "objects", "maintenance.lock"), "");
    writeFileSync(join(d, "a.txt"), "a\n");
    writeFileSync(join(d, "z.txt"), "z\n");
    return d;
  }
  const names = (tgz: Uint8Array): string[] =>
    readTarGz(tgz)
      .map((e) => e.path)
      .filter((p) => p !== "." && p !== "./");

  test("is skipped, like GNU tar's 'file removed before we read it', and reported once", () => {
    const d = tree("vanish-sync");
    const gone: string[] = [];
    const tgz = tarGzDirectory(d, ["."], {
      // removed after it was listed, before it is read
      beforeRead: (rel) => {
        if (rel === ".git/objects/maintenance.lock") rmSync(join(d, rel), { force: true });
      },
      onVanished: (rel) => gone.push(rel),
    });
    expect(gone).toEqual([".git/objects/maintenance.lock"]);
    const got = names(tgz);
    expect(got).toContain("a.txt");
    expect(got).toContain("z.txt");
    expect(got).toContain(".git/HEAD");
    expect(got).not.toContain(".git/objects/maintenance.lock");
    // and what is left is a good archive
    const out = join(tmp, "vanish-sync-out");
    mkdirSync(out);
    writeFileSync(join(tmp, "vanish-sync.tgz"), tgz);
    execFileSync("tar", ["xzf", join(tmp, "vanish-sync.tgz"), "-C", out]);
    expect(readFileSync(join(out, "z.txt"), "utf8")).toBe("z\n");
  });

  test("a directory that vanishes takes its children with it; the rest of the tree is kept", () => {
    const d = tree("vanish-dir");
    const gone: string[] = [];
    const tgz = tarGzDirectory(d, ["."], {
      beforeRead: (rel) => {
        if (rel === ".git/objects") rmSync(join(d, rel), { recursive: true, force: true });
      },
      onVanished: (rel) => gone.push(rel),
    });
    expect(gone).toEqual([".git/objects"]);
    expect(names(tgz)).toEqual(expect.arrayContaining(["a.txt", "z.txt", ".git/HEAD"]));
    expect(names(tgz).some((n) => n.startsWith(".git/objects"))).toBe(false);
  });

  test("the streaming writer skips it too, and the archive on disk is valid", async () => {
    const d = tree("vanish-stream");
    const gone: string[] = [];
    const out = join(tmp, "vanish-stream.tgz");
    await tarGzDirectoryToFile(d, out, {
      maxBytes: 1e7,
      hooks: {
        beforeRead: (rel) => {
          if (rel === "a.txt") rmSync(join(d, rel), { force: true });
        },
        onVanished: (rel) => gone.push(rel),
      },
    });
    expect(gone).toEqual(["a.txt"]);
    const got = names(new Uint8Array(readFileSync(out)));
    expect(got).not.toContain("a.txt");
    expect(got).toContain("z.txt");
  });

  test("with no hook the first one is logged at debug, once per pack", () => {
    const d = tree("vanish-log");
    const seen: string[] = [];
    const orig = console.debug;
    console.debug = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      tarGzDirectory(d, ["."], {
        beforeRead: (rel) => {
          if (rel === "a.txt" || rel === "z.txt") rmSync(join(d, rel), { force: true });
        },
      });
    } finally {
      console.debug = orig;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("vanished");
  });

  test("anything but ENOENT still fails, and so does an entry the caller named that is not there", () => {
    const d = tree("vanish-other");
    expect(() => tarGzDirectory(d, ["missing"])).toThrow(/ENOENT/);
    expect(() =>
      tarGzDirectory(d, ["."], {
        beforeRead: (rel) => {
          if (rel === "a.txt") throw Object.assign(new Error("boom"), { code: "EACCES" });
        },
      }),
    ).toThrow(/boom/);
  });

  test("a tree where nothing vanishes is packed exactly as before", async () => {
    const d = tree("vanish-none");
    const a = names(tarGzDirectory(d));
    const b = names(await tarDirectory(d));
    expect(a).toEqual(b);
    expect(a).toContain(".git/objects/maintenance.lock");
  });
});
