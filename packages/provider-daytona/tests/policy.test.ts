import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_LIVE,
  HARD_MAX_LIVE,
  MAX_TTL_SECONDS,
  NAME_PREFIX,
  clampMaxLive,
  ALL_STATES,
  LIVE_STATES,
  checkOwnerCiLabels,
  isOwnerCi,
  type OwnerCiLabels,
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
    expect(isOwn({ ...ok, name: "acme-ci-1" })).toBe(false);
    expect(isOwn({ ...ok, labels: { "longshore-dev": "0" } })).toBe(false);
    expect(isOwn({ ...ok, labels: {} })).toBe(false);
    expect(isOwn({ name: "longshore-dev-x" })).toBe(false);
  });

  test("every Daytona state holds quota except stopped, archived, destroyed and error", () => {
    const free = new Set(["stopped", "archived", "destroyed", "error"]);
    for (const state of ALL_STATES) expect(isLive(state)).toBe(!free.has(state));
    // transitional and odd states count too: when unsure, assume quota is held
    for (const state of [
      "started",
      "starting",
      "creating",
      "pending_build",
      "building_snapshot",
      "restoring",
      "stopping",
      "destroying",
      "build_failed",
      "unknown",
      "some-new-state",
    ]) {
      expect(isLive(state)).toBe(true);
    }
    expect(isLive(undefined)).toBe(false);
    expect(LIVE_STATES.toSorted()).toEqual(ALL_STATES.filter((s) => !free.has(s)).toSorted());
    expect(LIVE_STATES.some((s) => free.has(s))).toBe(false);
  });

  test("owner CI is the configured label key with an exact value, or a snapshot with one", () => {
    const l: OwnerCiLabels = { key: "project", values: ["acme-pub-ci", "acme-ci", "acme-release"] };
    for (const name of l.values) {
      expect(isOwnerCi({ labels: { project: name } }, l)).toBe(true);
      expect(isOwnerCi({ snapshot: name }, l)).toBe(true);
    }
    expect(isOwnerCi({ labels: { project: "acme-pub-ci-2" } }, l)).toBe(false);
    expect(isOwnerCi({ labels: { project: "ACME-CI" } }, l)).toBe(false);
    expect(isOwnerCi({ labels: { lane: "acme-ci" } }, l)).toBe(false); // right value, wrong key
    expect(isOwnerCi({ labels: { "acme-ci": "1" } }, l)).toBe(false); // right name as a key
    expect(isOwnerCi({ labels: { project: "acme-dev" }, snapshot: "acme-dev-warm" }, l)).toBe(
      false,
    );
    expect(isOwnerCi({}, l)).toBe(false);
    // another key, another account
    expect(isOwnerCi({ labels: { team: "x" } }, { key: "team", values: ["x"] })).toBe(true);
  });

  test("the labels are validated: a plain key, one to twenty plain values", () => {
    expect(checkOwnerCiLabels({ key: "project", values: ["a", "a", "b"] }).values).toEqual([
      "a",
      "b",
    ]);
    expect(() => checkOwnerCiLabels({ key: "", values: ["a"] })).toThrow(RangeError);
    expect(() => checkOwnerCiLabels({ key: "a b", values: ["a"] })).toThrow(RangeError);
    expect(() => checkOwnerCiLabels({ key: "project", values: [] })).toThrow(RangeError);
    expect(() => checkOwnerCiLabels({ key: "project", values: ["ok", "has space"] })).toThrow(
      RangeError,
    );
    expect(() =>
      checkOwnerCiLabels({ key: "project", values: Array.from({ length: 21 }, (_, i) => `v${i}`) }),
    ).toThrow(RangeError);
  });
});
