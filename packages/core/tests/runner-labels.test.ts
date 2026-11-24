// Per-org and per-project `runs-on` label maps (#492 part 2): registry definitions, the set-time
// refusal of classes the operator did not define, precedence over the instance map, and the
// untrusted rule. Runs on both dialects (TURNTABLE_TEST_DB).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "../src/db";
import { dispatch, registry, type Credential } from "../src/ops";
import { resolveRunnerLabelMaps } from "../src/scheduler/runner-labels";
import {
  parseSandboxSizes,
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
