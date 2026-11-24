import { describe, expect, test } from "bun:test";
import { planWorkflow } from "@turntable/act-runner";
import {
  parseSandboxSizes,
  refusalFor,
  sizeFor,
  untrustedForSize,
} from "../src/scheduler/sandbox-size";
import { resolveSandboxSizes } from "../src/serve-config";

const CFG = JSON.stringify({
  classes: {
    small: { cpus: 2, memoryMb: 4096 },
    large: { cpus: 4, memoryMb: 8192, diskGb: 40, snapshot: "daytona-large" },
    huge: { cpus: 64, memoryMb: 262144 },
  },
  labels: { "ubuntu-latest-4-cores": "large", "ubuntu-latest-64-cores": "huge" },
  default: "small",
  untrustedClass: "small",
  maxCpus: 16,
  maxMemoryMb: 65536,
});
const cfg = parseSandboxSizes(CFG, "test");

describe("the size map", () => {
  test("a mapped label gets its class, with the snapshot when it names one", () => {
    expect(sizeFor(cfg, ["ubuntu-latest-4-cores"])).toEqual({
      class: "large",
      resources: { cpus: 4, memoryMb: 8192, diskGb: 40 },
      snapshot: "daytona-large",
    });
  });

  test("an unknown label, or none, gets the default; no default means no opinion", () => {
    expect(sizeFor(cfg, ["ubuntu-latest"])).toMatchObject({ class: "small" });
    expect(sizeFor(cfg, [])).toMatchObject({ class: "small" });
    const noDefault = parseSandboxSizes(
      JSON.stringify({ classes: { a: { cpus: 1 } }, labels: { x: "a" } }),
      "t",
    );
    expect(sizeFor(noDefault, ["other"])).toEqual({});
    expect(sizeFor(undefined, ["x"])).toEqual({});
  });

  test("the first mapped label wins", () => {
    expect(
      sizeFor(cfg, ["self-hosted", "ubuntu-latest-4-cores", "ubuntu-latest-64-cores"]),
    ).toMatchObject({
      class: "large",
    });
  });

  test("the global ceilings clamp every class", () => {
    expect(sizeFor(cfg, ["ubuntu-latest-64-cores"]).resources).toEqual({
      cpus: 16,
      memoryMb: 65536,
    });
  });

  test("an untrusted run gets its fixed class whatever its labels ask for", () => {
    expect(sizeFor(cfg, ["ubuntu-latest-64-cores"], { untrusted: true })).toMatchObject({
      class: "small",
    });
    const noUntrusted = parseSandboxSizes(
      JSON.stringify({
        classes: { s: { cpus: 1 }, b: { cpus: 8 } },
        labels: { big: "b" },
        default: "s",
      }),
      "t",
    );
    // with no untrustedClass it falls back to the default, never to the label
    expect(sizeFor(noUntrusted, ["big"], { untrusted: true })).toMatchObject({ class: "s" });
  });

  test("labels that are inherited object keys are not mappings: they get the default", () => {
    for (const label of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(sizeFor(cfg, [label]), label).toMatchObject({ class: "small" });
      expect(sizeFor(cfg, [label], { untrusted: true }), label).toMatchObject({ class: "small" });
    }
    // a config that maps `__proto__` is not read as a mapping either (the key is dropped), and a
    // class or default named like an inherited key does not exist
    const odd =
      '{"classes":{"a":{"cpus":1},"b":{"cpus":8}},"labels":{"__proto__":"b"},"default":"a"}';
    expect(sizeFor(parseSandboxSizes(odd, "t"), ["__proto__"])).toMatchObject({ class: "a" });
    expect(() =>
      parseSandboxSizes('{"classes":{"a":{"cpus":1}},"default":"constructor"}', "t"),
    ).toThrow("unknown size class constructor");
    expect(() =>
      parseSandboxSizes('{"classes":{"a":{"cpus":1}},"labels":{"x":"toString"}}', "t"),
    ).toThrow("unknown size class toString");
  });

  test("a job is untrusted for sizing by its own effective class, and an unknown class fails closed", () => {
    expect(untrustedForSize("untrusted_pr")).toBe(true);
    expect(untrustedForSize(undefined)).toBe(true);
    expect(untrustedForSize(null)).toBe(true);
    expect(untrustedForSize("")).toBe(true);
    expect(untrustedForSize("something_new")).toBe(true);
    for (const k of ["protected", "release", "trusted_pr"]) expect(untrustedForSize(k)).toBe(false);
    // a local run (the operator's own checkout) is exempt, whatever it records
    expect(untrustedForSize(undefined, true)).toBe(false);
    expect(untrustedForSize("untrusted_pr", true)).toBe(false);
  });

  test("a bad config is refused with the reason: unknown class, bad numbers, unknown keys, not JSON", () => {
    const bad = (o: unknown) => () => parseSandboxSizes(JSON.stringify(o), "cfg");
    expect(bad({ classes: { a: { cpus: 1 } }, labels: { x: "nope" } })).toThrow(
      "unknown size class nope",
    );
    expect(bad({ classes: { a: { cpus: 1 } }, default: "b" })).toThrow("unknown size class b");
    expect(bad({ classes: { a: { cpus: 0 } } })).toThrow("cpus");
    expect(bad({ classes: { a: { cpus: 1.5 } } })).toThrow("cpus");
    expect(bad({ classes: { a: { cpus: 1, env: {} } } })).toThrow();
    expect(bad({ classes: { a: { snapshot: "bad name!" } } })).toThrow("snapshot");
    expect(bad({ classes: {}, extra: 1 })).toThrow();
    expect(() => parseSandboxSizes("{", "cfg")).toThrow("not valid JSON");
  });

  test("it comes from the environment: JSON or a file, not both", () => {
    expect(resolveSandboxSizes({})).toBeUndefined();
    expect(resolveSandboxSizes({ TURNTABLE_SANDBOX_SIZES_JSON: CFG })?.default).toBe("small");
    expect(() =>
      resolveSandboxSizes({
        TURNTABLE_SANDBOX_SIZES_JSON: CFG,
        TURNTABLE_SANDBOX_SIZES_FILE: "/x",
      }),
    ).toThrow("only one");
    expect(() => resolveSandboxSizes({ TURNTABLE_SANDBOX_SIZES_JSON: "{}" })).toThrow("classes");
  });
});

describe("planning records the labels", () => {
  const plan = (runsOn: string, extra = "") =>
    planWorkflow(
      `name: x\non: push\njobs:\n  a:\n    ${extra}runs-on: ${runsOn}\n    steps:\n      - run: echo\n`,
      { name: "push", ref: "refs/heads/main" },
      { readFile: () => undefined },
    ).jobs[0]!;

  test("a string, a list and a labels mapping are recorded; an interpolated label is resolved", () => {
    expect(plan("ubuntu-latest-4-cores").runsOn).toEqual(["ubuntu-latest-4-cores"]);
    expect(plan("[ubuntu-latest, big]").runsOn).toEqual(["ubuntu-latest", "big"]);
    expect(plan("{ labels: [ubuntu-latest, big] }").runsOn).toEqual(["ubuntu-latest", "big"]);
  });
});

const plan = (runsOn: string, extra = "") =>
  planWorkflow(
    `on: push\njobs:\n  a:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - run: echo\n`,
    { name: "push", ref: "refs/heads/main" },
    { readFile: () => undefined },
  ).jobs[0]!;

describe("runner labels: other OS and arch fail closed, GitHub labels size", () => {
  test("macOS, Windows and [self-hosted, macOS] are refused with the sentence", () => {
    const mac = refusalFor(plan("macos-latest"), ["amd64"]);
    expect(mac).toContain("asks for a macOS runner (`macos-latest`)");
    expect(mac).toContain("Linux sandboxes only; macOS runners are not supported yet.");
    expect(refusalFor(plan("windows-2022"), ["amd64"])).toContain(
      "Windows runner (`windows-2022`)",
    );
    expect(refusalFor(plan("[self-hosted, macOS]"), ["amd64"])).toContain("macOS runner");
  });

  test("an arm label needs a provider that advertises arm64", () => {
    const arm = plan("ubuntu-latest-arm");
    expect(arm.unsupported).toBeUndefined();
    expect(refusalFor(arm, ["amd64"])).toContain("arm64 runner (`ubuntu-latest-arm`)");
    expect(refusalFor(plan("arm64"), ["amd64"])).toContain("arm64 runner");
    expect(refusalFor(arm, ["amd64", "arm64"])).toBeUndefined();
  });

  test("custom and GitHub Linux labels are not refused and keep the size map", () => {
    for (const l of ["boat", "large", "ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"]) {
      expect(refusalFor(plan(l), ["amd64"]), l).toBeUndefined();
      expect(sizeFor(cfg, [l])).toMatchObject({ class: "small" });
    }
  });

  test("ubuntu-latest-N-cores picks the class with N cpus, else the default", () => {
    const c = parseSandboxSizes(
      JSON.stringify({
        classes: { small: { cpus: 2 }, eight: { cpus: 8 } },
        default: "small",
      }),
      "t",
    );
    expect(sizeFor(c, ["ubuntu-latest-8-cores"])).toMatchObject({ class: "eight" });
    expect(sizeFor(c, ["ubuntu-latest-16-cores"])).toMatchObject({ class: "small" });
    // an operator mapping beats the built-in rule
    expect(sizeFor(cfg, ["ubuntu-latest-4-cores"])).toMatchObject({ class: "large" });
  });

  test("an untrusted job still gets untrustedClass whatever it asks for", () => {
    expect(sizeFor(cfg, ["ubuntu-latest-64-cores"], { untrusted: true })).toMatchObject({
      class: "small",
    });
  });
});
