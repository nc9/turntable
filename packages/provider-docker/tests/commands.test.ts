import { describe, expect, test } from "bun:test";
import { SpecError, type SandboxSpec } from "@turntable/provider-sdk";
import {
  buildExecArgs,
  buildInspectArgs,
  buildPsArgs,
  buildRmArgs,
  buildRunArgs,
  sanitizeName,
} from "../src/commands";

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
    expect(a.slice(-4)).toEqual(["--", "alpine:3.22", "sleep", "600"]);
    expect(a).toContain("--network");
    expect(a[a.indexOf("--network") + 1]).toBe("none");
    expect(a[a.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(a[a.indexOf("--pids-limit") + 1]).toBe("4096");
    expect(a[a.indexOf("--cap-drop") + 1]).toBe("NET_RAW");
    expect(a).not.toContain("--runtime");
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

describe("hardening and egress", () => {
  test("open egress keeps the default network", () => {
    const a = buildRunArgs({ ...spec, network: { egress: "open" } }, 0);
    expect(a).not.toContain("--network");
  });
  test("overrides", () => {
    const a = buildRunArgs(spec, 0, {
      noNewPrivileges: false,
      pidsLimit: 0,
      capDrop: [],
      runtime: "runsc",
    });
    expect(a).not.toContain("--security-opt");
    expect(a).not.toContain("--pids-limit");
    expect(a).not.toContain("--cap-drop");
    expect(a[a.indexOf("--runtime") + 1]).toBe("runsc");
  });
  test("bad runtime or capability is rejected", () => {
    const h = { noNewPrivileges: true, pidsLimit: 1, capDrop: [] };
    expect(() => buildRunArgs(spec, 0, { ...h, runtime: "--privileged" })).toThrow(SpecError);
    expect(() => buildRunArgs(spec, 0, { ...h, capDrop: ["--x"] })).toThrow(SpecError);
  });
});

describe("argument injection", () => {
  test("image that looks like a flag is rejected", () => {
    for (const image of ["--privileged", "-v", "a b", "alpine;rm", ""]) {
      expect(() => buildRunArgs({ ...spec, image }, 0)).toThrow(SpecError);
    }
  });
  test("container refs that look like flags are rejected everywhere", () => {
    expect(() => buildExecArgs("--privileged", ["ls"], false)).toThrow(SpecError);
    expect(() => buildRmArgs("--privileged")).toThrow(SpecError);
    expect(() => buildInspectArgs(["ok1", "--privileged"])).toThrow(SpecError);
  });
  test("double dash precedes positional args", () => {
    expect(buildExecArgs("c1", ["ls"], false)).toEqual(["exec", "--", "c1", "ls"]);
    expect(buildRmArgs("c1")).toEqual(["rm", "-f", "--", "c1"]);
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
      "--",
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
