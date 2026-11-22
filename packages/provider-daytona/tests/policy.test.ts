import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_LIVE,
  FOREIGN_CI_LABELS,
  FOREIGN_WAIT_AT,
  HARD_MAX_LIVE,
  MAX_TTL_SECONDS,
  NAME_PREFIX,
  clampMaxLive,
  isLive,
  isOwn,
  ownName,
} from "../src/policy";

describe("customer-account rules", () => {
  test("the constants are what the account owner agreed to", () => {
    expect(DEFAULT_MAX_LIVE).toBe(2);
    expect(HARD_MAX_LIVE).toBe(3);
    expect(MAX_TTL_SECONDS).toBe(1800);
    expect(NAME_PREFIX).toBe("longshore-dev-");
    expect(FOREIGN_CI_LABELS).toEqual(["squirrel-pub-ci", "squirrel-ci", "squirrel-release"]);
    expect(FOREIGN_WAIT_AT).toBe(8);
  });

  test("maxLive can be lowered, never raised past the ceiling", () => {
    expect(clampMaxLive(undefined)).toBe(2);
    expect(clampMaxLive(1)).toBe(1);
    expect(clampMaxLive(3)).toBe(3);
    expect(() => clampMaxLive(4)).toThrow(/ceiling/);
    expect(() => clampMaxLive(0)).toThrow();
    expect(() => clampMaxLive(1.5)).toThrow();
  });

  test("names always carry the prefix and are DNS-safe, whatever is requested", () => {
    for (const n of [
      "tt-conf-abc-1",
      "Weird Name!!",
      "",
      "---",
      "a".repeat(200),
      "longshore-dev-already",
    ]) {
      const out = ownName(n);
      expect(out.startsWith(NAME_PREFIX)).toBe(true);
      expect(out).toMatch(/^[a-z0-9-]+$/);
      expect(out.length).toBeLessThanOrEqual(63);
    }
    expect(ownName("tt-conf-abc-1")).toBe("longshore-dev-tt-conf-abc-1");
  });

  test("ownership needs the label AND the name prefix", () => {
    const ok = { name: "longshore-dev-x", labels: { "longshore-dev": "1" } };
    expect(isOwn(ok)).toBe(true);
    expect(isOwn({ ...ok, name: "squirrel-ci-1" })).toBe(false);
    expect(isOwn({ ...ok, labels: { "longshore-dev": "0" } })).toBe(false);
    expect(isOwn({ ...ok, labels: {} })).toBe(false);
    expect(isOwn({ name: "longshore-dev-x" })).toBe(false);
  });

  test("states that are leaving do not occupy capacity", () => {
    expect(["creating", "started", "stopped", "starting", "pending_build"].every(isLive)).toBe(
      true,
    );
    expect(["destroyed", "destroying", "archived", "build_failed"].some(isLive)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });
});
