import { describe, expect, test } from "bun:test";
import {
  InfraError,
  SpecError,
  assertExecId,
  buildCmdScript,
  capOutput,
  newExecId,
  shellQuote,
  type SandboxSpec,
} from "../src/index";

describe("shellQuote", () => {
  test("quotes single quotes safely", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
  test("rejects NUL", () => {
    expect(() => shellQuote("a\0b")).toThrow(SpecError);
  });
});

describe("buildCmdScript", () => {
  test("exec with cwd", () => {
    expect(buildCmdScript({ argv: ["echo", "a b"], cwd: "/w" })).toBe(
      "cd '/w' || exit 126\nexec 'echo' 'a b'",
    );
  });
  test("rejects empty argv", () => {
    expect(() => buildCmdScript({ argv: [] })).toThrow(SpecError);
  });
});

describe("execId", () => {
  test("generated ids validate and are unique", () => {
    const a = newExecId();
    assertExecId(a);
    expect(newExecId()).not.toBe(a);
  });
  test("path tricks are rejected", () => {
    for (const bad of ["../x", "tt1-ZZ", "", "tt1-" + "a".repeat(23) + "/"]) {
      expect(() => assertExecId(bad)).toThrow(SpecError);
    }
  });
});

describe("capOutput", () => {
  const opts = { head: 10, tail: 20, slack: 5 };
  test("under head+tail+slack is untouched, with no cut", () => {
    const b = new Uint8Array(35);
    const out = capOutput(b, opts);
    expect(out.bytes).toBe(b);
    expect(out.cut).toBeUndefined();
  });
  test("over the limit keeps head and tail and reports the cut as data, with no marker bytes", () => {
    const b = Uint8Array.from({ length: 100 }, (_, i) => i);
    const out = capOutput(b, opts);
    expect(out.bytes.length).toBe(10 + 20);
    expect(Array.from(out.bytes.subarray(0, 10))).toEqual(Array.from(b.subarray(0, 10)));
    expect(Array.from(out.bytes.subarray(10))).toEqual(Array.from(b.subarray(80)));
    expect(out.cut).toEqual({ atOffset: 10, omittedBytes: 70 });
    expect(new TextDecoder().decode(out.bytes)).not.toContain("longshore");
  });
});

describe("errors and spec", () => {
  test("retryability", () => {
    expect(new InfraError("x").retryable).toBe(true);
    expect(new SpecError("x").retryable).toBe(false);
  });
  test("SandboxSpec has no env field", () => {
    const base: SandboxSpec = {
      name: "n",
      labels: {},
      ttlSeconds: 1,
      network: { egress: "none" },
    };
    // @ts-expect-error env must never be part of a sandbox spec
    const bad: SandboxSpec = { ...base, env: { A: "b" } };
    expect(bad).toBeDefined();
  });
});
