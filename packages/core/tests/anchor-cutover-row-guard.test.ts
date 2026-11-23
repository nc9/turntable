// The anchor v2 cutover (#398) is an org-scope `settings` row that is not in the registry (#410).
// No settings path may read, write, reset, delete or list it: the ops refuse its key as unknown,
// the lists never show it, and nothing that lists raw rows is reachable. If this fails because the
// key was registered, read #410 first: the row's stored shape and its CAS writer must move too.
// Runs on SQLite, and on pglite via TURNTABLE_TEST_DB.
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ANCHOR_CUTOVER_KEY,
  getAnchorCutover,
  recordAnchorCutover,
} from "../src/audit/anchor-cutover";
import { systemOrgId } from "../src/audit/failures";
import type { Db } from "../src/db";
import { dispatch, registry, type Credential } from "../src/ops";
import { settingsRegistry } from "../src/settings/definitions";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  expect(await recordAnchorCutover(db, a.orgId, { seq: 7, time: 1000 }, 1000)).toBe(true);
});

const admin = (): Credential => ({ kind: "principal", principal: a.admin });
const instance = async (): Promise<Credential> => ({
  kind: "principal",
  principal: {
    kind: "instance",
    id: "tti-test",
    orgId: await systemOrgId(db),
    role: "instance_admin",
  },
});
const run = (cred: Credential, op: string, input: object) =>
  dispatch({ registry, db }, cred, op, input);
const cutover = () => getAnchorCutover(db, a.orgId);

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist") return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|json)$/.test(f) ? [p] : [];
  });

describe("the cutover key is not a setting", () => {
  test("it is not in the registry", () => {
    expect(settingsRegistry.get(ANCHOR_CUTOVER_KEY)).toBeUndefined();
    expect(settingsRegistry.settings.map((d) => d.key)).not.toContain(ANCHOR_CUTOVER_KEY);
  });

  test("the org ops refuse it as unknown and leave the row alone", async () => {
    for (const [op, input] of [
      ["get_setting", { key: ANCHOR_CUTOVER_KEY }],
      ["set_setting", { key: ANCHOR_CUTOVER_KEY, value: { seq: 99, time: 1 } }],
      ["set_setting", { key: ANCHOR_CUTOVER_KEY, unset: true }],
    ] as const) {
      const r = await run(admin(), op, input);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error.code).toBe("not_found");
    }
    expect(await cutover()).toEqual({ seq: 7, time: 1000 });
  });

  test("the instance ops refuse it too, including a targeted write", async () => {
    const cred = await instance();
    for (const [op, input] of [
      ["instance_get_setting", { key: ANCHOR_CUTOVER_KEY }],
      ["instance_set_setting", { key: ANCHOR_CUTOVER_KEY, value: 1 }],
      ["instance_set_setting", { key: ANCHOR_CUTOVER_KEY, unset: true }],
      [
        "instance_set_setting",
        { key: ANCHOR_CUTOVER_KEY, unset: true, target_org: a.slug, target_project: a.projectSlug },
      ],
    ] as const) {
      const r = await run(cred, op, input);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error.code).toBe("not_found");
    }
    expect(await cutover()).toEqual({ seq: 7, time: 1000 });
  });

  test("the lists never show it", async () => {
    // The UI's settings pages are generated from list_settings and instance_list_settings.
    const org = await run(admin(), "list_settings", { limit: 100 });
    const inst = await run(await instance(), "instance_list_settings", {});
    for (const r of [org, inst]) {
      expect(r.ok).toBe(true);
      expect(JSON.stringify(r.ok ? r.output : r)).not.toContain(ANCHOR_CUTOVER_KEY);
    }
  });

  test("set_project_settings has no field that can name it", async () => {
    const op = registry.get("set_project_settings")!;
    const shape = Object.keys((op.input as unknown as { shape: object }).shape);
    expect(shape.sort()).toEqual(
      [
        "max_concurrent",
        "sandbox_snapshot",
        "target_org",
        "target_project",
        "untrusted_run_approval",
      ].sort(),
    );
  });
});

describe("no code reaches the row except the cutover module", () => {
  const src = join(import.meta.dir, "..", "src");
  const uiSrc = join(import.meta.dir, "..", "..", "ui", "src");

  test("only anchor-cutover.ts names the key in core, and the UI never does", () => {
    const hits = files(src).filter((f) => readFileSync(f, "utf8").includes(ANCHOR_CUTOVER_KEY));
    expect(hits.map((f) => relative(src, f))).toEqual([join("audit", "anchor-cutover.ts")]);
    for (const f of files(uiSrc)) expect(readFileSync(f, "utf8")).not.toContain(ANCHOR_CUTOVER_KEY);
  });

  test("listStoredSettings, which lists raw rows, has no caller in src", () => {
    const callers = files(src).filter(
      (f) =>
        !f.endsWith(join("db", "repos", "settings.ts")) &&
        readFileSync(f, "utf8").includes("listStoredSettings"),
    );
    expect(callers).toEqual([]);
  });
});
