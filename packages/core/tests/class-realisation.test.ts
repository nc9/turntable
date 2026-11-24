// Size classes per provider (#492 part 2): the `providers` shape, the deprecated top-level
// `snapshot` alias, and a provider that cannot realise a class.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaytonaProvider } from "@turntable/provider-daytona";
import { DockerProvider } from "@turntable/provider-docker";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { realiseSize } from "../src/scheduler/realise-size";
import { parseSandboxSizes, sizeFor } from "../src/scheduler/sandbox-size";

const cfg = parseSandboxSizes(
  JSON.stringify({
    classes: {
      c: {
        cpus: 4,
        memoryMb: 8192,
        providers: { daytona: { snapshot: "snap-c" }, docker: { image: "runner:big" } },
      },
      withDisk: { cpus: 2, diskGb: 50, providers: { docker: { image: "runner:disk" } } },
    },
    labels: { l: "c", d: "withDisk" },
    default: "c",
  }),
  "test",
);

const daytona = new DaytonaProvider({ apiKey: () => "x" });
const docker = new DockerProvider();

describe("per provider realisation", () => {
  test("Daytona realises providers.daytona.snapshot with the resources", () => {
    expect(realiseSize(daytona, sizeFor(cfg, ["l"]))).toEqual({
      ok: true,
      sandbox: { resources: { cpus: 4, memoryMb: 8192 }, snapshot: "snap-c" },
    });
  });

  test("Docker realises providers.docker.image with cpus and memory", () => {
    expect(realiseSize(docker, sizeFor(cfg, ["l"]))).toEqual({
      ok: true,
      sandbox: { resources: { cpus: 4, memoryMb: 8192 }, image: "runner:big" },
    });
  });

  test("Docker refuses a class that asks for a disk size", () => {
    const r = realiseSize(docker, sizeFor(cfg, ["d"]));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("disk");
  });

  test("a provider refuses settings that are not its own", () => {
    expect(daytona.realiseClass({ cpus: 1 }, { image: "x" }).ok).toBe(false);
    expect(docker.realiseClass({ cpus: 1 }, { snapshot: "x" }).ok).toBe(false);
    expect(docker.realiseClass({ cpus: 1 }, { image: "bad image!" }).ok).toBe(false);
  });

  test("a provider without realiseClass refuses a class with settings for it, else gets resources", () => {
    const fake = new FakeWorld().provider();
    expect(fake.realiseClass).toBeUndefined();
    // the class has settings for daytona and docker only: nothing for `fake`
    expect(realiseSize(fake, sizeFor(cfg, ["l"]))).toEqual({
      ok: true,
      sandbox: { resources: { cpus: 4, memoryMb: 8192 } },
    });
    const own = parseSandboxSizes(
      JSON.stringify({ classes: { c: { providers: { fake: { image: "x" } } } }, default: "c" }),
      "t",
    );
    expect(realiseSize(fake, sizeFor(own, [])).ok).toBe(false);
  });

  test("no class means no sandbox override", () => {
    expect(realiseSize(docker, {})).toEqual({ ok: true });
  });
});

describe("the deprecated top-level snapshot", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  test("is folded into providers.daytona.snapshot with one warning", () => {
    const legacy = JSON.stringify({
      classes: { oldone: { cpus: 2, snapshot: "legacy-snap" } },
      default: "oldone",
    });
    const c = parseSandboxSizes(legacy, "t");
    parseSandboxSizes(legacy, "t");
    expect(c.classes.oldone).toEqual({
      cpus: 2,
      tenantSelectable: true,
      providers: { daytona: { snapshot: "legacy-snap" } },
    });
    expect(
      realiseSize(daytona, sizeFor(c, [])).ok && realiseSize(daytona, sizeFor(c, [])),
    ).toMatchObject({
      sandbox: { snapshot: "legacy-snap" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("deprecated");
  });

  test("conflicting with providers.daytona.snapshot is a config error", () => {
    expect(() =>
      parseSandboxSizes(
        JSON.stringify({
          classes: { a: { snapshot: "one", providers: { daytona: { snapshot: "two" } } } },
        }),
        "t",
      ),
    ).toThrow(/disagree/);
  });
});
