import { describe, expect, test } from "bun:test";
import { SpecError, type SandboxSpec } from "@turntable/provider-sdk";
import { buildExecArgs, buildPsArgs, buildRunArgs, sanitizeName } from "../src/commands";

const spec: SandboxSpec = {
  name: "job 1/a",
  labels: { run: "r1" },
  image: "alpine:3.22",
  ttlSeconds: 600,
  network: { egress: "none" },
  resources: { cpus: 1.5, memoryMb: 512 },
};

describe("buildRunArgs", () => {
  test("labels, resources, ttl backstop, never env", () => {
    const a = buildRunArgs(spec, 1000);
    expect(a.slice(0, 4)).toEqual(["run", "-d", "--rm", "--init"]);
    expect(a).toContain("--cpus");
    expect(a[a.indexOf("--cpus") + 1]).toBe("1.5");
    expect(a[a.indexOf("--memory") + 1]).toBe("512m");
    expect(a).toContain("run=r1");
    expect(a).toContain("turntable.expires-at=601000");
    expect(a.slice(-3)).toEqual(["alpine:3.22", "sleep", "600"]);
    expect(a[a.indexOf("--name") + 1]).toBe("job-1-a");
    for (const bad of ["-e", "--env", "--env-file"]) expect(a).not.toContain(bad);
  });
  test("rejects what docker cannot do", () => {
    expect(() => buildRunArgs({ ...spec, image: undefined as never }, 0)).toThrow(SpecError);
    expect(() => buildRunArgs({ ...spec, snapshot: "s" }, 0)).toThrow(SpecError);
    expect(() => buildRunArgs({ ...spec, network: { egress: "allowlist" } }, 0)).toThrow(SpecError);
    expect(() => buildRunArgs({ ...spec, ttlSeconds: 0 }, 0)).toThrow(SpecError);
    expect(() => buildRunArgs({ ...spec, resources: { diskGb: 1 } }, 0)).toThrow(SpecError);
  });
});

describe("other commands", () => {
  test("ps filters are ANDed and always include the managed label", () => {
    expect(buildPsArgs({ a: "b" })).toEqual([
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=a=b",
      "--filter",
      "label=turntable.managed=1",
    ]);
  });
  test("exec args", () => {
    expect(buildExecArgs("c1", ["sh", "-c", "x"], true)).toEqual([
      "exec",
      "-i",
      "c1",
      "sh",
      "-c",
      "x",
    ]);
  });
  test("sanitizeName", () => {
    expect(sanitizeName("--a b")).toBe("a-b");
    expect(() => sanitizeName("///")).toThrow(SpecError);
  });
});
