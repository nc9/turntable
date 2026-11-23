import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_LIVE,
  HARD_MAX_LIVE,
  MAX_TTL_SECONDS,
  NAME_PREFIX,
  clampMaxLive,
  ALL_STATES,
  LIVE_STATES,
  isForeignCi,
  isLive,
  isOwn,
  ownName,
} from "../src/policy";

describe("customer-account rules", () => {
  test("the constants are what the account owner agreed to", () => {
    expect(DEFAULT_MAX_LIVE).toBe(2);
    expect(HARD_MAX_LIVE).toBe(5);
    expect(MAX_TTL_SECONDS).toBe(1800);
    expect(NAME_PREFIX).toBe("longshore-dev-");
  });

  test("maxLive can be lowered, never raised past the ceiling", () => {
    expect(clampMaxLive(undefined)).toBe(2);
    expect(clampMaxLive(1)).toBe(1);
    expect(clampMaxLive(3)).toBe(3);
    expect(clampMaxLive(5)).toBe(5);
    expect(() => clampMaxLive(6)).toThrow(/ceiling/);
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

  test("owner CI is the configured label key with an exact value, or a snapshot with one; with none configured nothing is", () => {
    const labels = { key: "project", values: ["acme-pub-ci", "acme-ci", "acme-release"] };
    for (const name of labels.values) {
      expect(isForeignCi({ labels: { project: name } }, labels)).toBe(true);
      expect(isForeignCi({ snapshot: name }, labels)).toBe(true);
    }
    expect(isForeignCi({ labels: { project: "acme-pub-ci-2" } }, labels)).toBe(false);
    expect(isForeignCi({ labels: { project: "ACME-CI" } }, labels)).toBe(false);
    expect(isForeignCi({ labels: { lane: "acme-ci" } }, labels)).toBe(false); // right value, wrong key
    expect(isForeignCi({ labels: { "acme-ci": "1" } }, labels)).toBe(false); // right name as a key
    expect(
      isForeignCi({ labels: { project: "acme-dev" }, snapshot: "acme-dev-warm" }, labels),
    ).toBe(false);
    expect(isForeignCi({}, labels)).toBe(false);
    // The key is the operator's: another key works, and the default key means nothing.
    const other = { key: "team", values: ["ci"] };
    expect(isForeignCi({ labels: { team: "ci" } }, other)).toBe(true);
    expect(isForeignCi({ labels: { project: "ci" } }, other)).toBe(false);
    // None configured: no label check at all.
    expect(isForeignCi({ labels: { project: "acme-ci" }, snapshot: "acme-ci" }, undefined)).toBe(
      false,
    );
  });
});
