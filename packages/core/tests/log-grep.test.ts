import { describe, expect, test } from "bun:test";
import { grepLog, type GrepInput } from "../src/ops/log-grep";

const enc = (s: string): Buffer => Buffer.from(s, "utf8");

/** A reader over an in-memory log. */
const reader =
  (log: Buffer) =>
  async (from: number, to: number): Promise<Buffer> =>
    log.subarray(from, Math.min(to, log.length));

const base: GrepInput = {
  pattern: "ERROR",
  regex: false,
  ignoreCase: false,
  context: 0,
  maxMatches: 20,
  maxBytes: 65_536,
};

/** `lines` filler lines of 64 bytes, with `hits` replaced by an ERROR line. */
function makeLog(lines: number, hits: number[]): Buffer {
  const set = new Set(hits);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const head = set.has(i) ? `ERROR line ${i} ` : `ok line ${i} `;
    out.push(head.padEnd(63, ".") + "\n");
  }
  return enc(out.join(""));
}

describe("grepLog", () => {
  test("a default call finds a match at about 700 KB in an 834 KB log", async () => {
    const log = makeLog(13_000, [10_900]); // 64 bytes a line: ~838 KB, hit at ~697 KB
    expect(log.length).toBeGreaterThan(830_000);
    const r = await grepLog(reader(log), log.length, 0, base);
    expect(r.matches).toBe(1);
    expect(r.text).toContain("ERROR line 10900");
    expect(r.stopped).toBe("end");
    expect(r.next).toBeNull();
  });

  test("max_matches stops with next_offset, and resuming finds the next match", async () => {
    const log = makeLog(2000, [100, 900, 1500]);
    const first = await grepLog(reader(log), log.length, 0, { ...base, maxMatches: 1 });
    expect(first.matches).toBe(1);
    expect(first.stopped).toBe("max_matches");
    expect(first.next).not.toBeNull();
    const second = await grepLog(reader(log), log.length, first.next!, { ...base, maxMatches: 1 });
    expect(second.text).toContain("ERROR line 900");
    expect(second.text).not.toContain("ERROR line 100 ");
    expect(second.stopped).toBe("max_matches");
    const third = await grepLog(reader(log), log.length, second.next!, base);
    expect(third.text).toContain("ERROR line 1500");
    expect(third.stopped).toBe("end");
    expect(third.next).toBeNull();
  });

  test("the last match ending the log reports end, not max_matches", async () => {
    const log = makeLog(50, [49]);
    const r = await grepLog(reader(log), log.length, 0, { ...base, maxMatches: 1 });
    expect(r.matches).toBe(1);
    expect(r.stopped).toBe("end");
    expect(r.next).toBeNull();
  });

  test("max_bytes caps only the output: stops with max_bytes and resumes", async () => {
    const log = makeLog(2000, [10, 20, 30, 40]);
    const first = await grepLog(reader(log), log.length, 0, { ...base, maxBytes: 150 });
    expect(first.stopped).toBe("max_bytes");
    expect(first.matches).toBe(2);
    expect(first.next).not.toBeNull();
    const rest = await grepLog(reader(log), log.length, first.next!, base);
    expect(rest.matches).toBe(2);
    expect(rest.text).toContain("ERROR line 30");
    expect(rest.stopped).toBe("end");
  });

  test("a log past the scan budget stops with scan_budget and pages on", async () => {
    const log = makeLog(10_000, [200, 9000]); // 640 KB
    const budget = 300_000;
    const first = await grepLog(reader(log), log.length, 0, { ...base, scanBytes: budget });
    expect(first.stopped).toBe("scan_budget");
    expect(first.matches).toBe(1);
    expect(first.text).toContain("ERROR line 200");
    expect(first.next).not.toBeNull();
    expect(first.next!).toBeLessThanOrEqual(budget);
    expect(first.next!).toBeGreaterThan(budget - 64);
    let next: number | null = first.next;
    let hits = first.matches;
    let guard = 0;
    while (next !== null && guard++ < 10) {
      const r = await grepLog(reader(log), log.length, next, { ...base, scanBytes: budget });
      hits += r.matches;
      next = r.next;
    }
    expect(hits).toBe(2);
  });

  test("a match spanning a chunk boundary is found exactly once", async () => {
    // Blocks are 256 KiB: put a hit line across offset 262144.
    const lines: string[] = [];
    let size = 0;
    while (size < 262_144 - 20) {
      const l = "x".repeat(99) + "\n";
      lines.push(l);
      size += l.length;
    }
    lines.push("before ERROR spanning the block boundary\n");
    for (let i = 0; i < 100; i++) lines.push("y".repeat(99) + "\n");
    const log = enc(lines.join(""));
    const idx = log.indexOf("ERROR spanning");
    expect(idx).toBeLessThan(262_144);
    expect(idx + 14).toBeGreaterThan(262_144 - 40);
    const r = await grepLog(reader(log), log.length, 0, base);
    expect(r.matches).toBe(1);
    expect(r.text.match(/ERROR spanning/g)).toHaveLength(1);
    // The same through a scan budget that ends inside the line: no loss, no repeat.
    const cut = log.indexOf("before ERROR") + 10;
    const a = await grepLog(reader(log), log.length, 0, { ...base, scanBytes: cut });
    expect(a.matches).toBe(0);
    expect(a.stopped).toBe("scan_budget");
    const b = await grepLog(reader(log), log.length, a.next!, base);
    expect(b.matches).toBe(1);
    expect(b.text.match(/ERROR spanning/g)).toHaveLength(1);
  });

  test("scan_budget scans the whole of a log larger than one read block", async () => {
    const log = makeLog(20_000, [19_900]); // 1.28 MB, hit near the end
    const r = await grepLog(reader(log), log.length, 0, base);
    expect(r.matches).toBe(1);
    expect(r.stopped).toBe("end");
  });
});
