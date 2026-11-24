import { describe, expect, test } from "bun:test";
import { parsePgConcurrency } from "./pg-concurrency";

describe("parsePgConcurrency", () => {
  test("defaults to 1 when unset or empty", () => {
    expect(parsePgConcurrency(undefined)).toBe(1);
    expect(parsePgConcurrency("")).toBe(1);
    expect(parsePgConcurrency("  ")).toBe(1);
  });

  test("accepts 1 to 8", () => {
    for (let n = 1; n <= 8; n++) expect(parsePgConcurrency(String(n))).toBe(n);
  });

  test("rejects anything else", () => {
    for (const bad of ["0", "9", "-1", "2.5", "abc", "1e1", "03", "10"]) {
      expect(() => parsePgConcurrency(bad)).toThrow("TURNTABLE_PG_TEST_CONCURRENCY");
    }
  });
});
