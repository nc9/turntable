// The strict scanner (scanTarGz): it accepts only what tarGzDirectoryToFile writes and refuses
// every other way of saying the same thing, because the server plans from what it scans and the
// sandbox extracts with GNU tar: a planner and an extractor that read an archive differently are
// the hole. One hostile archive per rule, then a fuzz-ish round trip against system tar.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { scanTarGz, tarGzDirectoryToFile, TarFormatError } from "../src/tar";

const tmp = mkdtempSync(join(tmpdir(), "ls-tarscan-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const OPTS = { maxUnpackedBytes: 1e8, maxEntries: 100_000, captureUpTo: 1e6, captureTotal: 1e8 };
const BLOCK = 512;

// ---- a raw header builder, independent of the writer under test ----

interface H {
  name?: string | Buffer;
  type?: string;
  size?: number;
  mode?: string;
  uid?: string;
  link?: string | Buffer;
  prefix?: string;
  uname?: string;
  magic?: string;
  version?: string;
  sizeField?: string;
  checksum?: "ok" | "bad";
  tail?: string; // bytes 500..512
}
const put = (b: Buffer, off: number, v: string | Buffer, len: number): void => {
  const x = typeof v === "string" ? Buffer.from(v, "latin1") : v;
  x.copy(b, off, 0, Math.min(len, x.length));
};
function hdr(o: H): Buffer {
  const b = Buffer.alloc(BLOCK);
  put(b, 0, o.name ?? "", 100);
  put(b, 100, o.mode ?? "0000644\0", 8);
  put(b, 108, o.uid ?? "0000000\0", 8);
  put(b, 116, "0000000\0", 8);
  put(b, 124, o.sizeField ?? `${(o.size ?? 0).toString(8).padStart(11, "0")}\0`, 12);
  put(b, 136, "00000000000\0", 12);
  put(b, 148, "        ", 8);
  put(b, 156, o.type ?? "0", 1);
  put(b, 157, o.link ?? "", 100);
  put(b, 257, o.magic ?? "ustar\0", 6);
  put(b, 263, o.version ?? "00", 2);
  put(b, 265, o.uname ?? "", 32);
  put(b, 345, o.prefix ?? "", 155);
  put(b, 500, o.tail ?? "", 12);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += b[i]!;
  if (o.checksum === "bad") sum += 1;
  put(b, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return b;
}
const data = (s: string | Buffer, pad = true): Buffer => {
  const x = typeof s === "string" ? Buffer.from(s) : s;
  return pad ? Buffer.concat([x, Buffer.alloc((BLOCK - (x.length % BLOCK)) % BLOCK)]) : x;
};
const END = Buffer.alloc(BLOCK * 2);
const file = (name: string, text = "x", over: H = {}): Buffer[] => [
  hdr({ name, size: text.length, ...over }),
  data(text),
];
const dir = (name: string, over: H = {}): Buffer[] => [
  hdr({ name, type: "5", mode: "0000755\0", ...over }),
];
const sym = (name: string, target: string, over: H = {}): Buffer[] => [
  hdr({ name, type: "2", mode: "0000777\0", link: target, ...over }),
];
const pax = (records: string, over: H = {}): Buffer[] => [
  hdr({ name: "PaxHeader", type: "x", size: Buffer.byteLength(records), ...over }),
  data(records),
];
const rec = (key: string, value: string): string => {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (Buffer.byteLength(`${len}${rest}`) !== len) len = Buffer.byteLength(`${len}${rest}`);
  return `${len}${rest}`;
};
const ROOT = dir("./");
const arc = (...parts: Buffer[][]): Uint8Array => gzipSync(Buffer.concat([...parts.flat(), END]));
const raw = (...parts: Buffer[]): Uint8Array => gzipSync(Buffer.concat(parts));

const refuses = async (tgz: Uint8Array, why: RegExp, label: string): Promise<void> => {
  let err: unknown;
  await scanTarGz(tgz, OPTS).catch((e) => (err = e));
  expect(err, label).toBeInstanceOf(TarFormatError);
  expect((err as Error).message, label).toMatch(why);
};

describe("the baseline", () => {
  test("a well-formed archive is accepted, with its root, a directory, a file and a symlink", async () => {
    const m = await scanTarGz(arc(ROOT, dir("d/"), file("d/f", "hello"), sym("l", "d/f")), OPTS);
    expect([...m.keys()]).toEqual([".", "d", "d/f", "l"]);
    expect(m.get("d/f")).toMatchObject({ type: "file", size: 5 });
    expect(new TextDecoder().decode(m.get("d/f")!.data)).toBe("hello");
    expect(m.get("l")).toMatchObject({ type: "symlink", linkTarget: "d/f" });
  });
});

describe("names: only canonical ones, nothing normalised and accepted", () => {
  test.each([
    ["an absolute path", file("/etc/x")],
    ["a doubled slash", file("a//b")],
    ["a . segment", file("a/./b")],
    ["a .. segment", file("a/../b")],
    ["a bare ..", file("..")],
    ["a ./ prefix on a file", file("./f")],
    ["a trailing slash on a file", file("f/")],
    ["an empty name", file("")],
    ["a directory without its slash", dir("d")],
    ["a directory with two slashes", dir("d//")],
  ])("refuses %s", async (_what, entry) => {
    await refuses(arc(ROOT, entry), /name|segment|slash|root|parent/i, _what);
  });

  test("refuses a name through the ustar prefix field, and a name field with bytes after its end", async () => {
    await refuses(arc(ROOT, file("f", "x", { prefix: "a/b" })), /never sets/, "prefix");
    const name = Buffer.alloc(100);
    name.write("f");
    name.write("junk", 10);
    await refuses(arc(ROOT, file("f", "x", { name })), /after its end/, "bytes after the name");
  });

  test("refuses duplicate names, a file and a directory of one name, and a name that is not UTF-8", async () => {
    await refuses(arc(ROOT, file("a"), file("a")), /repeated/, "duplicate file");
    await refuses(arc(ROOT, dir("a/"), file("a")), /repeated/, "dir then file");
    await refuses(arc(ROOT, file("a"), dir("a/")), /repeated/, "file then dir");
    await refuses(
      arc(ROOT, file("a", "x", { name: Buffer.from([0x61, 0xff, 0xfe]) })),
      /UTF-8/,
      "not utf-8",
    );
  });

  test("refuses anything under a symlink or a file, a missing parent, hard links, and entries out of place", async () => {
    await refuses(arc(ROOT, sym("s", "/etc"), file("s/x")), /under a symlink/, "under a symlink");
    await refuses(arc(ROOT, file("f"), file("f/x")), /under a symlink or a file/, "under a file");
    await refuses(arc(ROOT, file("a/b")), /no directory entry/, "missing parent");
    await refuses(arc(ROOT, dir("a/"), file("a/b/c")), /no directory entry/, "missing grandparent");
    await refuses(
      arc(ROOT, file("f"), [hdr({ name: "h", type: "1", link: "f" })]),
      /never carries/,
      "hard link",
    );
    await refuses(arc(file("f")), /root directory/, "no root");
    await refuses(arc(ROOT, ROOT), /repeated|root|segment/, "two roots");
    await refuses(arc(dir("a/"), ROOT), /root directory/, "root not first");
  });
});

describe("the end of the archive is exactly two zero blocks", () => {
  test("data after them, a third zero block, a lone zero block followed by data, one zero block, and none are refused", async () => {
    const body = [...ROOT, ...file("f")];
    await refuses(
      raw(...body, END, hdr({ name: "late", size: 0 })),
      /after the end/,
      "an entry after the end",
    );
    await refuses(raw(...body, END, Buffer.alloc(BLOCK)), /after the end/, "a third zero block");
    await refuses(
      raw(...body, END, Buffer.from("trailing garbage")),
      /after the end/,
      "garbage after the end",
    );
    await refuses(
      raw(...body, Buffer.alloc(BLOCK), hdr({ name: "g" }), data("x")),
      /zero block is followed/,
      "lone zero block then data",
    );
    await refuses(raw(...body, Buffer.alloc(BLOCK)), /cut short|no end/, "one zero block");
    await refuses(raw(...body), /cut short|no end/, "no end blocks");
    await refuses(
      raw(...ROOT, hdr({ name: "f", size: 100 }), Buffer.alloc(50)),
      /cut short|no end/,
      "truncated data",
    );
  });
});

describe("pax: only the records the writer emits, framed exactly, consistent with the header", () => {
  const long = "p".repeat(150);
  const head100 = Buffer.from(long.slice(0, 100));
  test("the writer's own pax shape is accepted", async () => {
    const m = await scanTarGz(
      arc(ROOT, pax(rec("path", long)), file("x", "1", { name: head100 })),
      OPTS,
    );
    expect(m.has(long)).toBe(true);
  });
  test.each([
    ["an unknown record", pax(rec("mtime", "1")), /never carries/],
    ["a size record", pax(rec("size", "5")), /never carries/],
    ["a record with a bad length", pax("0 path=x\n"), /bad length/],
    ["a record with a non-numeric length", pax("abc path=x\n"), /bad length/],
    ["a length that does not match", pax(`99 path=${long}\n`), /not framed/],
    ["a repeated record", pax(rec("path", long) + rec("path", long)), /repeated/],
    [
      "a value short enough to need no record",
      pax(rec("path", "short")),
      /needs no pax record|short enough/,
    ],
    ["trailing bytes after the records", pax(rec("path", long) + "junk"), /bad length|not framed/],
    ["an empty pax header", pax(""), /bad size/],
    [
      "a pax header that is not the writer's",
      pax(rec("path", long), { name: "OtherName" }),
      /not the one this archive writes/,
    ],
    [
      "a pax header with another mode",
      pax(rec("path", long), { mode: "0000600\0" }),
      /not the one this archive writes/,
    ],
  ])("refuses %s", async (_w, p, why) => {
    await refuses(arc(ROOT, p, file("x", "1", { name: head100 })), why, _w);
  });
  test("refuses a pax path that is not the entry's header name, two pax headers in a row, a trailing pax, a linkpath on a file, and a header name that is not 100 bytes", async () => {
    await refuses(
      arc(ROOT, pax(rec("path", long)), file("x", "1", { name: "different" })),
      /does not match its pax path/,
      "name mismatch",
    );
    await refuses(
      arc(ROOT, pax(rec("path", long)), pax(rec("path", long)), file("x", "1", { name: head100 })),
      /two pax headers/,
      "two pax",
    );
    await refuses(
      arc(ROOT, pax(rec("path", long))),
      /not followed by an entry|cut short|no end/,
      "trailing pax",
    );
    await refuses(
      arc(ROOT, pax(rec("linkpath", long)), file("x", "1", { name: head100 })),
      /pax linkpath on something/,
      "linkpath on a file",
    );
    await refuses(
      arc(ROOT, pax(rec("path", long)), file("x", "1", { name: head100.subarray(0, 60) })),
      /does not match its pax path/,
      "short header name",
    );
    const target = "t".repeat(130);
    await refuses(
      arc(ROOT, pax(rec("linkpath", target)), sym("s", "other")),
      /does not match its pax linkpath/,
      "linkpath mismatch",
    );
  });
});

describe("header fields, types and padding", () => {
  test.each([
    ["a bad checksum", file("f", "x", { checksum: "bad" }), /checksum/],
    ["a char device", [hdr({ name: "c", type: "3" })], /never carries/],
    ["a GNU long name header", [hdr({ name: "L", type: "L", size: 0 })], /never carries/],
    ["a global pax header", [hdr({ name: "g", type: "g", size: 0 })], /never carries/],
    ["the old NUL regular-file type", file("f", "x", { type: "\0" }), /never carries/],
    ["the contiguous-file type", file("f", "x", { type: "7" }), /never carries/],
    [
      "a size that is not canonical octal",
      file("f", "x", { sizeField: "  1\0\0\0\0\0\0\0\0\0" }),
      /not canonical/,
    ],
    [
      "a size with a trailing space",
      file("f", "x", { sizeField: "00000000001 " }),
      /not canonical/,
    ],
    ["a non-zero uname", file("f", "x", { uname: "root" }), /never sets/],
    ["a wrong magic", file("f", "x", { magic: "ustar " }), /not ustar/],
    ["a wrong version", file("f", "x", { version: " \0" }), /not ustar/],
    ["a non-zero uid", file("f", "x", { uid: "0000001\0" }), /owner/],
    ["setuid mode bits", file("f", "x", { mode: "0004755\0" }), /mode bits/],
    ["junk in the header's tail", file("f", "x", { tail: "zz" }), /never sets/],
    ["a size on a directory", [hdr({ name: "d/", type: "5", size: 4 })], /has a size/],
    ["a size on a symlink", sym("s", "t", { size: 4 }), /has a size/],
    ["a link target on a file", file("f", "x", { link: "t" }), /no symlink has a link target/],
  ])("refuses %s", async (_w, entry, why) => {
    await refuses(arc(ROOT, entry), why, _w);
  });
  test("refuses non-zero padding after file data", async () => {
    const dirty = data("x");
    dirty[100] = 1;
    await refuses(arc(ROOT, [hdr({ name: "f", size: 1 }), dirty]), /padding/, "dirty padding");
  });
});

describe("what the writer writes always passes, and system tar extracts exactly what the scanner reports", () => {
  // a small deterministic generator
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789-_日本語";
  const segment = (): string => {
    const len = 1 + rnd(28);
    let s = "";
    for (let i = 0; i < len; i += 1) s += [...ALPHA][rnd([...ALPHA].length)];
    return s === "." || s === ".." ? "x" : s;
  };

  test("random trees: long names, deep paths, long symlink targets, empty files, many entries", async () => {
    for (let round = 0; round < 25; round += 1) {
      const root = join(tmp, `fz${round}`);
      mkdirSync(root);
      const made = new Set<string>();
      const n = 1 + rnd(30);
      for (let i = 0; i < n; i += 1) {
        const depth = 1 + rnd(7);
        const segs = Array.from({ length: depth }, () => segment());
        const path = segs.join("/");
        // names that fold together would collide on a case-insensitive disk: keep them distinct
        if (
          [...made].some(
            (m) =>
              m.toLowerCase() === path.toLowerCase() ||
              m.toLowerCase().startsWith(`${path.toLowerCase()}/`) ||
              path.toLowerCase().startsWith(`${m.toLowerCase()}/`),
          )
        )
          continue;
        try {
          mkdirSync(join(root, ...segs.slice(0, -1)), { recursive: true });
          if (rnd(4) === 0) {
            symlinkSync("t".repeat(rnd(160)) || "t", join(root, path));
          } else {
            writeFileSync(join(root, path), "z".repeat(rnd(3) === 0 ? 0 : rnd(3000)));
          }
          made.add(path);
        } catch {
          // a path the disk would not take: not part of the tree
        }
      }
      const out = join(tmp, `fz${round}.tgz`);
      await tarGzDirectoryToFile(root, out, { maxBytes: 1e8 });
      const tgz = new Uint8Array(readFileSync(out));
      const scanned = await scanTarGz(tgz, OPTS);
      // system tar's extraction of the same file
      const x = join(tmp, `fz${round}-x`);
      mkdirSync(x);
      execFileSync("tar", ["xzf", out, "-C", x]);
      const extracted = new Map<string, "file" | "dir" | "symlink">();
      const walk = (rel: string): void => {
        for (const name of readdirSync(join(x, rel)).toSorted()) {
          const p = rel === "" ? name : `${rel}/${name}`;
          const st = lstatSync(join(x, p));
          extracted.set(p, st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file");
          if (st.isDirectory()) walk(p);
        }
      };
      walk("");
      const reported = new Map(
        [...scanned].filter(([k]) => k !== ".").map(([k, v]) => [k, v.type] as const),
      );
      expect([...reported].toSorted()).toEqual([...extracted].toSorted());
      // and the contents agree for files, the targets for symlinks
      for (const [k, v] of scanned) {
        if (k === ".") continue;
        if (v.type === "file") expect(readFileSync(join(x, k)).length).toBe(v.size);
        if (v.type === "symlink") expect(readlinkSync(join(x, k))).toBe(v.linkTarget!);
      }
      // the listing system tar gives is the same set
      const listing = execFileSync("tar", ["tzf", out], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((l) => l.replace(/^\.\//, "").replace(/\/$/, ""))
        .filter((l) => l !== "" && l !== ".");
      expect(listing.toSorted()).toEqual([...reported.keys()].toSorted());
    }
  }, 120_000);
});
