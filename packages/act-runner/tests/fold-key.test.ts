// foldKey must be a fixed point: the symlink guard and the .git disguise check compare folded keys,
// so a key that folds further on a second pass would let two spellings of one name through.
import { describe, expect, test } from "bun:test";
import { foldKey } from "../src/fold-key";

describe("foldKey", () => {
  test("folds case, normalisation, ignorable characters and trailing dots and spaces", () => {
    expect(foldKey("A/B")).toBe("a/b");
    expect(foldKey("café")).toBe(foldKey("café"));
    expect(foldKey(".g‌it")).toBe(".git");
    expect(foldKey("a. .")).toBe("a");
    expect(foldKey("a/b./c ")).toBe("a/b/c");
  });

  test("is idempotent over random strings with combining marks, ignorables and special cases", () => {
    let seed = 424242;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return (seed >>> 8) % n;
    };
    const pieces = [
      "a",
      "B",
      ".",
      " ",
      "/",
      "‌",
      "‍",
      "‮",
      "﻿",
      "́",
      "̇",
      "̣",
      "İ",
      "ı",
      "I",
      "i",
      "ß",
      "ẞ",
      "SS",
      "Σ",
      "σ",
      "ς",
      "K",
      "K",
      "é",
      "e",
      "ẛ̣",
      "ﬁ",
      "Ω",
      "Ω",
      "ǅ",
      "😀",
      "가",
      "가",
      ".git",
      "..",
      "․",
    ];
    for (let i = 0; i < 20000; i += 1) {
      let s = "";
      const n = 1 + rnd(10);
      for (let j = 0; j < n; j += 1) s += pieces[rnd(pieces.length)];
      const once = foldKey(s);
      expect(foldKey(once), JSON.stringify(s)).toBe(once);
    }
  });

  test("steps that re-create foldable forms are followed to the end", () => {
    // U+0130 lower-cases to i + U+0307; a trailing ignorable after a dot hides the dot
    expect(foldKey("a.‌")).toBe("a");
    expect(foldKey("a‌.‌.")).toBe("a");
    expect(foldKey("İ")).toBe(foldKey(foldKey("İ")));
  });
});
