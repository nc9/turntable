import { expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION_RE as SCRIPT_RE } from "../../../scripts/build-version";
import { VERSION, VERSION_RE, assertValidVersion } from "../src/version";

const pkg = (await Bun.file(join(import.meta.dir, "../../../package.json")).json()) as {
  version: string;
};

test("the no-define fallback is the root base with dev0+unknown", () => {
  expect(VERSION).toBe(`${pkg.version}-dev0+unknown`);
});

test("the regex accepts versions the build produces", () => {
  for (const v of ["0.1.0-dev7+594b21af", "0.1.0-alpha.1", "0.0.0-dryrun.1", "0.1.0"]) {
    expect(VERSION_RE.test(v)).toBe(true);
  }
});

test("the regex rejects malformed versions", () => {
  for (const v of ["v0.1.0", "0.1", "0.1.0-dev7+", "", "0.1.0-dev 7"]) {
    expect(VERSION_RE.test(v)).toBe(false);
  }
});

test("the boot check refuses an invalid version and accepts the real one", () => {
  expect(() => assertValidVersion("not a version")).toThrow(/invalid build version/);
  expect(() => assertValidVersion("")).toThrow();
  expect(() => assertValidVersion()).not.toThrow();
});

test("the core regex equals the one in scripts/build-version.ts", () => {
  expect(VERSION_RE.source).toBe(SCRIPT_RE.source);
});
