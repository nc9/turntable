import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERSION_RE,
  resolveBuildSha,
  resolveBuildTime,
  resolveBuildVersion,
} from "./build-version";

const SHA = "594b21af0123456789abcdef0123456789abcdef";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bv-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("env beats the BUILD_VERSION file, which beats the derived default", () => {
  writeFileSync(join(root, "BUILD_VERSION"), "0.1.0-dev3+aaaaaaaa\n");
  expect(
    resolveBuildVersion({ TURNTABLE_VERSION: "0.1.0-dev7+594b21af" }, "0.1.0", SHA, root),
  ).toBe("0.1.0-dev7+594b21af");
  expect(resolveBuildVersion({}, "0.1.0", SHA, root)).toBe("0.1.0-dev3+aaaaaaaa");
  rmSync(join(root, "BUILD_VERSION"));
  expect(resolveBuildVersion({}, "0.1.0", SHA, root)).toBe("0.1.0-dev0+594b21af");
});

test("a leading v is stripped and operator values are verbatim", () => {
  expect(resolveBuildVersion({ TURNTABLE_VERSION: "v0.1.0-alpha.1" }, "0.1.0", SHA)).toBe(
    "0.1.0-alpha.1",
  );
});

test("the derived default uses unknown without a sha", () => {
  expect(resolveBuildVersion({}, "0.1.0", "unknown")).toBe("0.1.0-dev0+unknown");
});

test("an empty or blank TURNTABLE_VERSION falls through to derive", () => {
  expect(resolveBuildVersion({ TURNTABLE_VERSION: "  " }, "0.1.0", SHA)).toBe(
    "0.1.0-dev0+594b21af",
  );
});

test("an invalid value fails and names its source", () => {
  expect(() => resolveBuildVersion({ TURNTABLE_VERSION: "0.1" }, "0.1.0", SHA)).toThrow(
    /TURNTABLE_VERSION/,
  );
  writeFileSync(join(root, "BUILD_VERSION"), "nope\n");
  expect(() => resolveBuildVersion({}, "0.1.0", SHA, root)).toThrow(/BUILD_VERSION file/);
  expect(() => resolveBuildVersion({}, "bad", SHA)).toThrow(/package.json/);
});

test("the regex accepts release inputs", () => {
  for (const v of ["0.1.0-alpha.1", "0.0.0-dryrun.1"]) expect(VERSION_RE.test(v)).toBe(true);
});

test("resolveBuildSha accepts only 40 hex", () => {
  expect(resolveBuildSha(root)).toBe("unknown");
  writeFileSync(join(root, "BUILD_SHA"), "abc123\n");
  expect(resolveBuildSha(root)).toBe("unknown");
  writeFileSync(join(root, "BUILD_SHA"), `${SHA}\n`);
  expect(resolveBuildSha(root)).toBe(SHA);
});

test("the build time never reads the wall clock", () => {
  expect(resolveBuildTime({}, () => undefined)).toBe("unknown");
  expect(resolveBuildTime({ SOURCE_DATE_EPOCH: "0" }, () => undefined)).toBe(
    "1970-01-01T00:00:00.000Z",
  );
  expect(resolveBuildTime({}, () => "2026-01-02T03:04:05+00:00")).toBe("2026-01-02T03:04:05.000Z");
  expect(resolveBuildTime({}, () => "garbage")).toBe("unknown");
});

test("a BUILD_TIME file supplies the time without git, below SOURCE_DATE_EPOCH", () => {
  const file = join(root, "BUILD_TIME");
  writeFileSync(file, "2026-01-02T03:04:05+02:00\n");
  expect(resolveBuildTime({}, () => undefined, root)).toBe("2026-01-02T01:04:05.000Z");
  writeFileSync(file, "86400\n");
  expect(resolveBuildTime({}, () => undefined, root)).toBe("1970-01-02T00:00:00.000Z");
  // file beats git, SOURCE_DATE_EPOCH beats the file
  expect(resolveBuildTime({}, () => "2030-01-01T00:00:00Z", root)).toBe("1970-01-02T00:00:00.000Z");
  expect(resolveBuildTime({ SOURCE_DATE_EPOCH: "0" }, () => undefined, root)).toBe(
    "1970-01-01T00:00:00.000Z",
  );
});

test("a malformed BUILD_TIME file is ignored", () => {
  const file = join(root, "BUILD_TIME");
  for (const bad of ["", "garbage", "2026-13-45T00:00:00Z", "2026-01-02", "now", "-5"]) {
    writeFileSync(file, `${bad}\n`);
    expect(resolveBuildTime({}, () => undefined, root)).toBe("unknown");
    expect(resolveBuildTime({}, () => "2026-01-02T03:04:05Z", root)).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  }
});
