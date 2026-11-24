// Per-org and per-project `runs-on` label maps (#492 part 2): registry definitions, the set-time
// refusal of classes the operator did not define, precedence over the instance map, and the
// untrusted rule. Runs on both dialects (TURNTABLE_TEST_DB).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../src/db";
import { dispatch, registry, type Credential } from "../src/ops";
import { resolveRunnerLabelMaps } from "../src/scheduler/runner-labels";
import {
  parseSandboxSizes,
  refuseLabelMap,
  setOperatorSizes,
  sizeFor,
  type SandboxSizes,
} from "../src/scheduler/sandbox-size";
import { loadSettingsRuntime } from "../src/settings/boot";
import {
  orgRunnerLabelsSetting,
  projectRunnerLabelsSetting,
  settingsRegistry,
} from "../src/settings/definitions";
import type { SettingsRuntime } from "../src/settings/resolve";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const sizes: SandboxSizes = parseSandboxSizes(
  JSON.stringify({
    classes: { small: { cpus: 2 }, medium: { cpus: 4 }, big: { cpus: 32 }, tiny: { cpus: 1 } },
    labels: { "ubuntu-latest-4-cores": "medium", "team-box": "small" },
    default: "small",
    untrustedClass: "tiny",
    maxCpus: 8,
  }),
  "test",
);

let db: Db;
let a: Tenant;
const rt = (toml?: string): SettingsRuntime =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env: {},
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  setOperatorSizes(sizes);
});
afterEach(() => setOperatorSizes(undefined));

async function setVia(settings: SettingsRuntime, key: string, value: unknown) {
  const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
  return dispatch(
    { registry, db, settings },
    { kind: "bearer", token: secret } as Credential,
    "set_setting",
    {
      key,
      value,
    },
  );
}

describe("the definitions", () => {
  test("org and project scope, release_operator role, no env var, MCP may not edit", () => {
    expect(orgRunnerLabelsSetting).toMatchObject({
      scope: "org",
      role: "release_operator",
      env: [],
      mcpEditable: false,
      toml: "runner_labels",
      default: {},
    });
    expect(projectRunnerLabelsSetting).toMatchObject({
      scope: "project",
      role: "release_operator",
      env: [],
      mcpEditable: false,
      toml: "runner_labels",
    });
    expect(settingsRegistry.get("runner_labels")).toBe(orgRunnerLabelsSetting);
    expect(settingsRegistry.get("project_runner_labels")).toBe(projectRunnerLabelsSetting);
  });

  test("a class the operator did not define is refused at set time, a defined one is accepted", async () => {
    const r = rt();
    const bad = await setVia(r, "project_runner_labels", { "my-box": "nonexistent" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error.code).toBe("invalid_input");
    const ok = await setVia(r, "project_runner_labels", { "my-box": "medium" });
    expect(ok.ok).toBe(true);
    const org = await setVia(r, "runner_labels", { "my-box": "nonexistent" });
    expect(org.ok).toBe(false);
  });

  test("with no operator classes at all, nothing can be named", async () => {
    setOperatorSizes(undefined);
    expect((await setVia(rt(), "project_runner_labels", { x: "small" })).ok).toBe(false);
  });

  test("a turntable.toml value locks it", async () => {
    const r = rt(`[orgs.${a.slug}.projects.${a.projectSlug}]\nrunner_labels = { x = "small" }\n`);
    const res = await setVia(r, "project_runner_labels", { x: "medium" });
    expect(res.ok).toBe(false);
  });
});

describe("resolution", () => {
  const sizeWith = async (r: SettingsRuntime, labels: string[], untrusted = false) =>
    sizeFor(sizes, labels, {
      untrusted,
      overrides: await resolveRunnerLabelMaps(db, a.scope, r),
    });

  test("a project override within the ceilings resolves", async () => {
    const r = rt();
    expect((await setVia(r, "project_runner_labels", { "my-box": "medium" })).ok).toBe(true);
    expect(await sizeWith(r, ["my-box"])).toMatchObject({
      class: "medium",
      resources: { cpus: 4 },
    });
  });

  test("a class above the ceilings is clamped, never exceeded", async () => {
    const r = rt();
    expect((await setVia(r, "project_runner_labels", { "my-box": "big" })).ok).toBe(true);
    expect((await sizeWith(r, ["my-box"])).resources).toEqual({ cpus: 8 });
  });

  test("project beats org beats instance", async () => {
    const r = rt();
    // instance: team-box -> small
    expect(await sizeWith(r, ["team-box"])).toMatchObject({ class: "small" });
    expect((await setVia(r, "runner_labels", { "team-box": "medium" })).ok).toBe(true);
    expect(await sizeWith(r, ["team-box"])).toMatchObject({ class: "medium" });
    expect((await setVia(r, "project_runner_labels", { "team-box": "big" })).ok).toBe(true);
    expect(await sizeWith(r, ["team-box"])).toMatchObject({ class: "big" });
  });

  test("a toml org map is read through the same resolver", async () => {
    const r = rt(`[orgs.${a.slug}]\nrunner_labels = { "my-box" = "medium" }\n`);
    expect(await sizeWith(r, ["my-box"])).toMatchObject({ class: "medium" });
  });

  test("untrusted still gets untrustedClass whatever the maps say", async () => {
    const r = rt();
    expect((await setVia(r, "project_runner_labels", { "my-box": "big" })).ok).toBe(true);
    expect(await sizeWith(r, ["my-box"], true)).toMatchObject({ class: "tiny" });
  });

  test("a stored name the operator later dropped falls through to the instance map", async () => {
    const r = rt();
    expect((await setVia(r, "project_runner_labels", { "team-box": "big" })).ok).toBe(true);
    setOperatorSizes(undefined);
    const narrower = parseSandboxSizes(
      JSON.stringify({ classes: { small: { cpus: 2 } }, labels: { "team-box": "small" } }),
      "t",
    );
    const out = sizeFor(narrower, ["team-box"], {
      overrides: await resolveRunnerLabelMaps(db, a.scope, r),
    });
    expect(out).toMatchObject({ class: "small" });
  });
});

describe("tenantSelectable and the org allowlist (#506)", () => {
  const gated = (orgs?: string[]): SandboxSizes =>
    parseSandboxSizes(
      JSON.stringify({
        classes: {
          small: { cpus: 2 },
          mac: { cpus: 4, tenantSelectable: false, ...(orgs ? { orgs } : {}) },
          tiny: { cpus: 1 },
        },
        labels: { "op-mac": "mac" },
        default: "small",
        untrustedClass: "tiny",
      }),
      "test",
    );

  test("a plain class is tenantSelectable by default", () => {
    expect(gated().classes.small?.tenantSelectable).toBe(true);
    expect(gated().classes.mac?.tenantSelectable).toBe(false);
  });

  test("a map naming a non-selectable class is refused at set time, without naming another org", async () => {
    setOperatorSizes(gated(["some-other-org"]));
    const res = await setVia(rt(), "runner_labels", { x: "mac" });
    expect(res.ok).toBe(false);
    const why = refuseLabelMap({ x: "mac" }, { orgSlug: a.slug }) ?? "";
    expect(why).toContain("mac");
    expect(why).not.toContain("some-other-org");
  });

  test("an org on the class's allowlist can name it; another org cannot", async () => {
    setOperatorSizes(gated([a.slug]));
    expect((await setVia(rt(), "runner_labels", { x: "mac" })).ok).toBe(true);
    expect((await setVia(rt(), "project_runner_labels", { y: "mac" })).ok).toBe(true);
    setOperatorSizes(gated(["org-z"]));
    expect((await setVia(rt(), "runner_labels", { x: "mac" })).ok).toBe(false);
  });

  test("turntable.toml: refused for a non-listed org, accepted for a listed one", () => {
    setOperatorSizes(gated([a.slug]));
    expect(() => rt(`[orgs.${a.slug}]\nrunner_labels = { x = "mac" }\n`)).not.toThrow();
    expect(() => rt(`[orgs.other]\nrunner_labels = { x = "mac" }\n`)).toThrow(/mac/);
  });

  test("a stored map whose class became non-selectable is ignored at run time, one log line", async () => {
    setOperatorSizes(gated([a.slug]));
    const r = rt();
    expect((await setVia(r, "runner_labels", { "my-box": "mac" })).ok).toBe(true);
    const maps = await resolveRunnerLabelMaps(db, a.scope, r);
    const lines: string[] = [];
    const later = gated(); // the operator dropped the allowlist
    const out = sizeFor(later, ["my-box", "my-box"], {
      overrides: maps,
      orgSlug: a.slug,
      log: (l) => lines.push(l),
    });
    expect(out.class).toBe("small");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("my-box");
    expect(lines[0]).toContain("mac");
    // falls back to the instance map when it maps the label
    const viaInstance = sizeFor(later, ["op-mac"], { overrides: maps, orgSlug: a.slug });
    expect(viaInstance.class).toBe("mac");
    // and an allowlisted org still gets it
    expect(sizeFor(gated([a.slug]), ["my-box"], { overrides: maps, orgSlug: a.slug }).class).toBe(
      "mac",
    );
  });

  test("the operator's instance map routes to it; untrusted still gets untrustedClass", () => {
    const g = gated();
    expect(sizeFor(g, ["op-mac"], { orgSlug: a.slug }).class).toBe("mac");
    expect(
      sizeFor(g, ["op-mac"], { untrusted: true, overrides: [{ "op-mac": "mac" }], orgSlug: "x" })
        .class,
    ).toBe("tiny");
  });

  test("an invalid orgs entry is rejected at config parse", () => {
    for (const bad of [["bad slug"], [""], [1], Array.from({ length: 65 }, (_, i) => `o${i}`)]) {
      expect(() =>
        parseSandboxSizes(JSON.stringify({ classes: { c: { cpus: 1, orgs: bad } } }), "t"),
      ).toThrow();
    }
  });
});
