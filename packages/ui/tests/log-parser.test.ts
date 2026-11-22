import { describe, expect, test } from "bun:test";
import { LogParser, parseAll, visibleLines } from "../src/log/parser";
import { findMatches } from "../src/log/search";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const ESC = "\u001b";

function feed(parser: LogParser, parts: string[]): void {
  let offset = parser.nextOffset;
  for (const p of parts) {
    const b = bytes(p);
    parser.push(b, offset);
    offset += b.length;
  }
}

describe("lines and chunk boundaries", () => {
  test("a line split across chunks is emitted once, whole", () => {
    const p = new LogParser();
    feed(p, ["hel", "lo wor", "ld\nsecond", " line\n"]);
    expect(p.lines.map((l) => l.text)).toEqual(["hello world", "second line"]);
  });

  test("the unfinished tail is exposed as pending, not as a line", () => {
    const p = new LogParser();
    feed(p, ["done\npartial"]);
    expect(p.lineCount).toBe(1);
    expect(p.pendingText).toBe("partial");
    feed(p, [" end\n"]);
    expect(p.lineCount).toBe(2);
    expect(p.pendingText).toBe("");
  });

  test("a multi-byte character split across chunks decodes intact", () => {
    const all = bytes("check ✓ done\n");
    const cut = all.indexOf(0xe2) + 1; // inside the 3-byte check mark
    const p = new LogParser();
    p.push(all.subarray(0, cut), 0);
    p.push(all.subarray(cut), cut);
    expect(p.lines[0]?.text).toBe("check ✓ done");
  });

  test("byte offsets are exact per line", () => {
    const p = parseAll(bytes("ab\n✓✓\nlast\n"));
    expect(p.lines.map((l) => l.offset)).toEqual([0, 3, 10]);
  });

  test("replayed (overlapping) chunks are deduplicated and gaps are rejected", () => {
    const p = new LogParser();
    const first = bytes("one\ntwo\n");
    expect(p.push(first, 0)).toBe("ok");
    expect(p.push(first, 0)).toBe("duplicate");
    expect(p.push(bytes("two\nthree\n"), 4)).toBe("ok");
    expect(p.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(p.push(bytes("x\n"), 999)).toBe("gap");
    expect(p.nextOffset).toBe(first.length + 6);
  });

  test("starts at a non-zero offset (load window)", () => {
    const p = new LogParser(100);
    p.push(bytes("x\n"), 100);
    expect(p.lines[0]?.offset).toBe(100);
  });

  test("CRLF and carriage-return progress lines keep the final frame", () => {
    const p = parseAll(bytes("a\r\nprogress 10%\rprogress 100%\n"));
    expect(p.lines.map((l) => l.text)).toEqual(["a", "progress 100%"]);
  });

  test("timestamps are stripped and parsed", () => {
    const p = parseAll(bytes("2026-11-22T10:00:00.250Z hello\n"));
    expect(p.lines[0]?.text).toBe("hello");
    expect(p.lines[0]?.ts).toBe(Date.parse("2026-11-22T10:00:00.250Z"));
  });
});

describe("ansi", () => {
  test("colours become classes and the reset ends them", () => {
    const p = parseAll(bytes(`${ESC}[31mred${ESC}[0m plain\n`));
    const line = p.lines[0]!;
    expect(line.text).toBe("red plain");
    expect(line.segs?.map((s) => s.text)).toEqual(["red", " plain"]);
    expect(p.styles[line.segs![0]!.style]?.cls).toBe("af-1");
    expect(line.segs![1]!.style).toBe(0);
  });

  test("style state carries across chunk boundaries inside a line and across lines", () => {
    const p = new LogParser();
    feed(p, [`${ESC}[1;32mbold gr`, `een\nstill green${ESC}[0m\nplain\n`]);
    const [a, b, c] = p.lines;
    expect(p.styles[a!.segs![0]!.style]?.cls).toContain("af-2");
    expect(p.styles[a!.segs![0]!.style]?.cls).toContain("ansi-b");
    expect(p.styles[b!.segs![0]!.style]?.cls).toContain("af-2");
    expect(c!.segs).toBeNull();
  });

  test("an escape sequence split across chunks is applied once the line completes", () => {
    const p = new LogParser();
    feed(p, [`pre ${ESC}[3`, `1mred${ESC}[0m\n`]);
    expect(p.lines[0]?.text).toBe("pre red");
    expect(p.styles[p.lines[0]!.segs![1]!.style]?.cls).toBe("af-1");
  });

  test("256 and truecolor produce inline colours; non-SGR escapes are dropped", () => {
    const p = parseAll(bytes(`${ESC}[38;5;196mA${ESC}[38;2;1;2;3mB${ESC}[2K${ESC}[0mC\n`));
    const segs = p.lines[0]!.segs!;
    expect(p.styles[segs[0]!.style]?.color).toBe("#ff0000");
    expect(p.styles[segs[1]!.style]?.color).toBe("#010203");
    expect(p.lines[0]?.text).toBe("ABC");
  });
});

describe("groups", () => {
  const log =
    [
      "::group::Install",
      "a",
      "::group::inner",
      "b",
      "::endgroup::",
      "c",
      "::endgroup::",
      "after",
    ].join("\n") + "\n";

  test("nesting, membership and visibility with defaults", () => {
    const p = parseAll(bytes(log));
    expect(p.groups.length).toBe(3);
    expect(p.groups[2]?.parent).toBe(1);
    // closed groups collapse by default: only the outer header and 'after' remain visible
    const vis = Array.from(visibleLines(p, new Map())).map((i) => p.lines[i]?.text);
    expect(vis).toEqual(["Install", "after"]);
  });

  test("expanding the outer group keeps the inner collapsed until expanded", () => {
    const p = parseAll(bytes(log));
    const vis = Array.from(visibleLines(p, new Map([[1, false]]))).map((i) => p.lines[i]?.text);
    expect(vis).toEqual(["Install", "a", "inner", "c", "after"]);
  });

  test("a group with an error opens by default; an open group stays expanded", () => {
    const p = parseAll(
      bytes("::group::T\nx\n::error::boom\n::endgroup::\n::group::live\nstill running\n"),
    );
    expect(p.groups[1]?.hasError).toBe(true);
    const vis = Array.from(visibleLines(p, new Map())).map((i) => p.lines[i]?.text);
    expect(vis).toEqual(["T", "x", "boom", "live", "still running"]);
  });
});

describe("annotations", () => {
  test("parses level, props and message, and links to the line", () => {
    const p = parseAll(
      bytes(
        "x\n::error file=src/a.ts,line=12,col=3,title=Bad%2Cthing::oops: it broke\n::warning::careful\n::notice title=Cache::hit\n",
      ),
    );
    expect(p.annotations.map((a) => a.level)).toEqual(["error", "warning", "notice"]);
    const err = p.annotations[0]!;
    expect(err).toMatchObject({
      file: "src/a.ts",
      line: 12,
      col: 3,
      title: "Bad,thing",
      message: "oops: it broke",
      lineIndex: 1,
    });
    expect(p.lines[1]?.level).toBe("error");
    expect(p.annotations[2]?.title).toBe("Cache");
  });

  test("a command split across chunks is parsed after the newline", () => {
    const p = new LogParser();
    feed(p, ["::warn", "ing file=a.ts,line=1::th", "is\n"]);
    expect(p.annotations[0]).toMatchObject({ level: "warning", message: "this", file: "a.ts" });
  });
});

describe("steps and cuts", () => {
  const step = (o: object) => `::tt-step::${JSON.stringify(o)}\n`;

  test("step boundaries give duration and result, and tag the lines inside", () => {
    const p = parseAll(
      bytes(
        `2026-11-22T10:00:00.000Z ${step({ phase: "start", index: 1, name: "Build" })}` +
          `2026-11-22T10:00:01.000Z compiling\n` +
          `2026-11-22T10:00:05.500Z ${step({ phase: "end", index: 1, result: "failure" })}` +
          `outside\n`,
      ),
    );
    const s = p.steps[0]!;
    expect(s).toMatchObject({ index: 1, name: "Build", result: "failure" });
    expect((s.endTs ?? 0) - (s.startTs ?? 0)).toBe(5500);
    expect(p.lines.map((l) => [l.kind, l.step])).toEqual([
      ["step", 1],
      ["text", 1],
      ["text", 0],
    ]);
  });

  test("an unfinished step stays open (result null)", () => {
    const p = parseAll(bytes(step({ phase: "start", index: 1, name: "Run" }) + "line\n"));
    expect(p.steps[0]?.result).toBeNull();
    expect(p.lines[1]?.step).toBe(1);
  });

  test("cut markers carry the omitted byte count", () => {
    const p = parseAll(bytes(`::tt-cut::${JSON.stringify({ bytes: 4096, reason: "middle" })}\n`));
    expect(p.lines[0]).toMatchObject({ kind: "cut", cutBytes: 4096 });
  });
});

describe("search and scale", () => {
  test("finds case-insensitive matches with columns", () => {
    const p = parseAll(bytes("Hello world\nnothing\nhello again hello\n"));
    const m = findMatches(p.lines, "HELLO");
    expect(m.map((x) => [x.line, x.start])).toEqual([
      [0, 0],
      [2, 0],
      [2, 12],
    ]);
  });

  test("parses 100k lines incrementally in chunks without losing any", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const all = bytes(text);
    const p = new LogParser();
    for (let off = 0; off < all.length; off += 4096) p.push(all.subarray(off, off + 4096), off);
    expect(p.lineCount).toBe(100_000);
    expect(p.lines[99_999]?.text).toBe("line 99999");
    expect(visibleLines(p, new Map()).length).toBe(100_000);
  });

  test("a huge unbroken line is split instead of buffering without bound", () => {
    const p = parseAll(bytes("x".repeat(200_000) + "\n"));
    expect(p.lineCount).toBeGreaterThan(2);
    expect(p.lines.map((l) => l.text.length).reduce((a, b) => a + b, 0)).toBe(200_000);
  });
});

describe("untrusted input neutralisation", () => {
  const OSC = "\u001b]";
  const BEL = "\u0007";
  const textOf = (s: string) => parseAll(bytes(s)).lines.map((l) => l.text);

  test("OSC 8 hyperlinks are dropped; only the visible text survives", () => {
    expect(textOf(`see ${OSC}8;;https://evil.example${BEL}click me${OSC}8;;${BEL} now\n`)).toEqual([
      "see click me now",
    ]);
    expect(textOf(`${OSC}8;;https://evil.example\u001b\\link${OSC}8;;\u001b\\\n`)).toEqual([
      "link",
    ]);
  });

  test("title-setting OSC and unterminated OSC never reach the output", () => {
    expect(textOf(`a${OSC}0;pwned${BEL}b\n`)).toEqual(["ab"]);
    expect(textOf(`a${OSC}0;never ends\n`)).toEqual(["a"]);
  });

  test("cursor movement, erase and other CSI are removed, only SGR styles remain", () => {
    const p = parseAll(bytes("x\u001b[2J\u001b[H\u001b[10;5Hy\u001b[1A\u001b[Kz\u001b[31mred\n"));
    expect(p.lines[0]?.text).toBe("xyzred");
    expect(p.styles.length).toBe(2); // default plus red
  });

  test("lone escapes, C1 introducers, bell, backspace and bidi overrides are stripped", () => {
    expect(textOf("a\u001b7b\u001bc\n")).toEqual(["ab"]);
    expect(textOf("a\u009b31mb\u009d0;t\u0007c\n")).toEqual(["a31mb0;tc"]);
    expect(textOf("a\u0007\u0008\u007fb\n")).toEqual(["ab"]);
    expect(textOf("ok ‮evil⁦ ‏\n")).toEqual(["ok evil "]);
  });

  test("annotation text is plain text: markup stays literal and escapes are stripped", () => {
    const p = parseAll(
      bytes(
        `::error title=<b>x</b>::<img src=x onerror=alert(1)>${OSC}8;;https://e${BEL}hi${OSC}8;;${BEL}\n`,
      ),
    );
    const a = p.annotations[0]!;
    expect(a.title).toBe("<b>x</b>");
    expect(p.lines[0]?.text).toBe("<img src=x onerror=alert(1)>hi");
  });
});
