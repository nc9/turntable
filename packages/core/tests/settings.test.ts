// The settings registry (#321): definitions, the turntable.toml loader, the four-layer resolver,
// and the get, list and set operations. Runs on both dialects (TURNTABLE_TEST_DB).
import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { chainedAudit, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { getStoredSetting, putStoredSetting } from "../src/db/repos/settings";
import { dispatch, registry, type Credential, type DispatchEnv } from "../src/ops";
import { createSettingsRegistry, defineSetting } from "../src/settings/define";
import { backupKeepSetting, settingsRegistry } from "../src/settings/definitions";
import { loadSettingsRuntime } from "../src/settings/boot";
import {
  createSettingsRuntime,
  resolveSetting,
  resolveSettingBeforeDb,
  type SettingsRuntime,
} from "../src/settings/resolve";
import { loadTomlSettings, SettingsConfigError } from "../src/settings/toml";
import { systemOrgId } from "../src/audit/failures";
import { mintToken, seedTenant, seedWorld, type Tenant } from "./ops-helpers";

// A registry with one setting per scope and per MCP rule, beside the shipped instance one.
const orgLimit = defineSetting({
  key: "org_limit",
  scope: "org",
  type: z.int().min(1).max(100),
  default: 5,
  role: "admin",
  mcpEditable: false,
  mcpReason: "it raises a limit",
  description: "A limit an org admin may raise, never an agent.",
  env: ["TT_TEST_ORG_LIMIT"],
  envParse: Number,
  toml: "limits.org",
});
const orgLabel = defineSetting({
  key: "org_label",
  scope: "org",
  type: z.string().max(20),
  default: "none",
  role: "operator",
  mcpEditable: true,
  description: "A harmless label an operator may set, by agent too.",
  toml: "label",
});
const projectNote = defineSetting({
  key: "project_note",
  scope: "project",
  type: z.string().max(20),
  default: "",
  role: "operator",
  mcpEditable: true,
  description: "A note kept per project, for the tests.",
  toml: "note",
});
const testRegistry = createSettingsRegistry([backupKeepSetting, orgLimit, orgLabel, projectNote]);

let db: Db;
let a: Tenant;
const rt = (env: Record<string, string> = {}, toml?: string): SettingsRuntime =>
  loadSettingsRuntime({
    registry: testRegistry,
    env,
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });
const run = (
  settings: SettingsRuntime,
  cred: Credential,
  op: string,
  input: object,
  extra: Partial<DispatchEnv> = {},
) => dispatch({ registry, db, settings, ...extra }, cred, op, input);
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
const errOf = (r: Awaited<ReturnType<typeof run>>) => (r.ok ? undefined : r.error);

beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

describe("definitions", () => {
  test("a secret can never be a setting", () => {
    const base = {
      scope: "instance",
      type: z.string(),
      default: "",
      role: "instance_admin",
      mcpEditable: false,
      mcpReason: "x",
      description: "Something that must never be stored here.",
    } as const;
    expect(() => defineSetting({ ...base, key: "api_token", toml: "a.b" })).toThrow(/secrets/);
    expect(() => defineSetting({ ...base, key: "fine", toml: "db.password" })).toThrow(/secrets/);
    expect(() =>
      defineSetting({ ...base, key: "fine", toml: "a.b", env: ["TURNTABLE_X_SECRET"] }),
    ).toThrow(/secrets/);
    expect(() =>
      defineSetting({ ...base, key: "fine", toml: "a.b", secret: true } as never),
    ).toThrow(/secret/);
  });

  test("the shipped registry has no secret-looking key, path or variable", () => {
    for (const d of settingsRegistry.settings) {
      expect(`${d.key} ${d.toml} ${d.env.join(" ")}`).not.toMatch(/secret|token|password|key_/i);
    }
  });

  test("a limit-raising setting must say why MCP may not change it; the default must be valid", () => {
    expect(() =>
      defineSetting({ ...orgLimit, key: "x_limit", toml: "x", mcpReason: undefined } as never),
    ).toThrow(/mcpReason/);
    expect(() => defineSetting({ ...orgLimit, key: "x_limit", toml: "x", default: 0 })).toThrow(
      /default/,
    );
    expect(() =>
      defineSetting({ ...orgLimit, key: "x_limit", toml: "x", role: "instance_admin" }),
    ).toThrow();
  });

  test("duplicate keys, clashing TOML paths and shared variables are refused", () => {
    expect(() => createSettingsRegistry([orgLabel, orgLabel])).toThrow(/duplicate/);
    const clash = defineSetting({ ...orgLabel, key: "other", toml: "label.sub" });
    expect(() => createSettingsRegistry([orgLabel, clash])).toThrow(/clashes/);
    const sameEnv = defineSetting({ ...orgLimit, key: "other_limit", toml: "z.z" });
    expect(() => createSettingsRegistry([orgLimit, sameEnv])).toThrow(/already sets/);
  });
});

describe("strictness", () => {
  const mode = {
    key: "x_mode",
    scope: "org" as const,
    type: z.enum(["loose", "strict"]),
    default: "loose" as const,
    role: "admin" as const,
    instanceAdminOnly: true,
    mcpEditable: false,
    mcpReason: "a person decides",
    description: "A test setting with an order of strictness.",
    toml: "x_mode",
  };

  test("is accepted with instanceAdminOnly and refused without it or with a bad order", () => {
    expect(defineSetting({ ...mode, strictness: ["loose", "strict"] }).strictness).toEqual([
      "loose",
      "strict",
    ]);
    expect(() =>
      defineSetting({ ...mode, instanceAdminOnly: false, strictness: ["loose", "strict"] }),
    ).toThrow(/needs instanceAdminOnly/);
    expect(() => defineSetting({ ...mode, strictness: ["loose", "loose"] })).toThrow(/distinct/);
    expect(() => defineSetting({ ...mode, strictness: ["loose", "wild"] })).toThrow(/not valid/);
    expect(() =>
      defineSetting({ ...mode, strictness: ["strict", "loose"], default: "loose" }),
    ).not.toThrow();
    expect(() => defineSetting({ ...mode, strictness: ["strict", "strict2"] })).toThrow();
  });
});

describe("turntable.toml", () => {
  test("no file at all is fine: an empty layer", () => {
    const layer = loadTomlSettings(undefined, testRegistry);
    expect(layer.file).toBeUndefined();
    expect(layer.instance.size).toBe(0);
    expect(resolveSettingBeforeDb(rt(), "backup_keep")).toMatchObject({
      value: 10,
      source: "default",
      locked: false,
    });
  });

  test("reads instance, org and project sections", () => {
    const layer = loadTomlSettings("t.toml", testRegistry, () =>
      [
        "[backup]",
        "keep = 3",
        "[orgs.acme]",
        'label = "hi"',
        "[orgs.acme.limits]",
        "org = 7",
        "[orgs.acme.projects.web]",
        'note = "n"',
      ].join("\n"),
    );
    expect(layer.instance.get("backup_keep")).toBe(3);
    expect(layer.orgs.get("acme")?.get("org_limit")).toBe(7);
    expect(layer.orgs.get("acme")?.get("org_label")).toBe("hi");
    expect(layer.projects.get("acme/web")?.get("project_note")).toBe("n");
  });

  const load = (text: string) => () =>
    loadTomlSettings("/etc/tt/turntable.toml", testRegistry, () => text);

  test("an unknown key fails naming the key and the file", () => {
    expect(load("[backup]\nkeeep = 3")).toThrow(
      "/etc/tt/turntable.toml: unknown setting backup.keeep",
    );
    expect(load("nope = 1")).toThrow("unknown setting nope");
    expect(load("[orgs.acme]\nbackup = 1")).toThrow("unknown setting orgs.acme.backup");
    // A setting of another scope is not valid in this section.
    expect(load("[orgs.acme.projects.web]\nlabel = 'x'")).toThrow(
      "unknown setting orgs.acme.projects.web.label",
    );
  });

  test("a bad value fails naming the key, the setting and the file", () => {
    expect(load("[backup]\nkeep = 0")).toThrow(
      /\/etc\/tt\/turntable\.toml: backup\.keep \(setting backup_keep\): /,
    );
    expect(load('[backup]\nkeep = "ten"')).toThrow(/backup\.keep \(setting backup_keep\)/);
    expect(load("[orgs.acme.limits]\norg = 1000")).toThrow(
      /orgs\.acme\.limits\.org \(setting org_limit\)/,
    );
  });

  test("bad TOML and an unreadable file fail naming the file", () => {
    expect(load("[backup")).toThrow(/turntable\.toml: not valid TOML/);
    expect(() => loadTomlSettings("/nope/x.toml", testRegistry)).toThrow(SettingsConfigError);
    expect(() => loadTomlSettings("/nope/x.toml", testRegistry)).toThrow(
      "/nope/x.toml: cannot read",
    );
  });

  test("--config beats TURNTABLE_CONFIG, and the environment is checked at boot too", () => {
    const read = (p: string) => (p === "flag.toml" ? "[backup]\nkeep = 4" : "[backup]\nkeep = 9");
    const r = loadSettingsRuntime({
      registry: testRegistry,
      env: { TURNTABLE_CONFIG: "env.toml" },
      config: "flag.toml",
      read,
    });
    expect(resolveSettingBeforeDb(r, "backup_keep").value).toBe(4);
    expect(() => rt({ TURNTABLE_BACKUP_KEEP: "two" })).toThrow(
      "TURNTABLE_BACKUP_KEEP (setting backup_keep)",
    );
  });
});

describe("precedence: env, then toml, then db, then default", () => {
  test("all four layers, each hiding the one below, and the lock follows", async () => {
    const inst = await instance();
    const bare = rt();
    expect(await resolveSetting(bare, db, "backup_keep")).toEqual({
      key: "backup_keep",
      value: 10,
      source: "default",
      locked: false,
    });
    const set = await run(bare, inst, "instance_set_setting", { key: "backup_keep", value: 20 });
    expect(set.ok).toBe(true);
    expect(await resolveSetting(bare, db, "backup_keep")).toMatchObject({
      value: 20,
      source: "db",
      locked: false,
    });
    const withToml = rt({}, "[backup]\nkeep = 30");
    expect(await resolveSetting(withToml, db, "backup_keep")).toMatchObject({
      value: 30,
      source: "toml",
      locked: true,
      origin: "turntable.toml",
    });
    const withEnv = rt({ TURNTABLE_BACKUP_KEEP: "40" }, "[backup]\nkeep = 30");
    expect(await resolveSetting(withEnv, db, "backup_keep")).toMatchObject({
      value: 40,
      source: "env",
      locked: true,
      origin: "TURNTABLE_BACKUP_KEEP",
    });
    // An empty variable is not set.
    expect(
      (await resolveSetting(rt({ TURNTABLE_BACKUP_KEEP: " " }), db, "backup_keep")).source,
    ).toBe("db");
  });

  test("org and project TOML sections are per org and per project", async () => {
    const r = rt({}, "[orgs.org-a]\nlabel = 'A'\n[orgs.org-a.projects.app]\nnote = 'P'");
    expect(
      await resolveSetting(r, db, "org_label", { orgId: a.orgId, orgSlug: "org-a" }),
    ).toMatchObject({
      value: "A",
      source: "toml",
    });
    expect(
      await resolveSetting(r, db, "org_label", { orgId: "other", orgSlug: "org-b" }),
    ).toMatchObject({
      value: "none",
      source: "default",
    });
    const subject = {
      orgId: a.orgId,
      orgSlug: "org-a",
      projectId: a.projectId,
      projectSlug: "app",
    };
    expect(await resolveSetting(r, db, "project_note", subject)).toMatchObject({ value: "P" });
    expect(
      (await resolveSetting(r, db, "project_note", { ...subject, projectSlug: "other" })).source,
    ).toBe("default");
  });

  test("a stored value that no longer validates is ignored, not used", async () => {
    const r = rt();
    await run(r, await instance(), "instance_set_setting", { key: "backup_keep", value: 5 });
    const tight = createSettingsRuntime(
      createSettingsRegistry([defineSetting({ ...backupKeepSetting, type: z.int().min(10) })]),
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await resolveSetting(tight, db, "backup_keep")).toMatchObject({ source: "default" });
    } finally {
      console.warn = warn;
    }
  });
});

describe("set_setting and the instance twin", () => {
  test("an instance set stores, audits old and new values, and reads back", async () => {
    const r = rt();
    const inst = await instance();
    const out = await run(r, inst, "instance_set_setting", { key: "backup_keep", value: 12 });
    expect(out.ok && out.output).toMatchObject({ value: 12, source: "db", locked: false });
    await run(r, inst, "instance_set_setting", { key: "backup_keep", value: 15 });
    const rows = (await chainedAudit(db, await systemOrgId(db), 0, 100)).filter(
      (e) => e.op === "setting_changed",
    );
    expect(rows.map((e) => JSON.parse(e.input))).toEqual([
      { key: "backup_keep", from: 10, to: 12, source: "db" },
      { key: "backup_keep", from: 12, to: 15, source: "db" },
    ]);
    const got = await run(r, inst, "instance_get_setting", { key: "backup_keep" });
    expect(got.ok && got.output).toMatchObject({ value: 15, source: "db" });
    // unset returns it to the default.
    const un = await run(r, inst, "instance_set_setting", { key: "backup_keep", unset: true });
    expect(un.ok && un.output).toMatchObject({ value: 10, source: "default" });
  });

  test("a locked setting is refused, naming where it is set", async () => {
    const inst = await instance();
    const env = await run(rt({ TURNTABLE_BACKUP_KEEP: "7" }), inst, "instance_set_setting", {
      key: "backup_keep",
      value: 8,
    });
    expect(errOf(env)).toMatchObject({ code: "conflict" });
    expect(errOf(env)?.message).toContain("TURNTABLE_BACKUP_KEEP");
    const file = await run(rt({}, "[backup]\nkeep = 7"), inst, "instance_set_setting", {
      key: "backup_keep",
      value: 8,
    });
    expect(errOf(file)?.message).toContain("turntable.toml");
    const view = await run(rt({}, "[backup]\nkeep = 7"), inst, "instance_get_setting", {
      key: "backup_keep",
    });
    expect(view.ok && view.output).toMatchObject({
      locked: true,
      source: "toml",
      locked_by: "turntable.toml",
    });
    // Nothing was stored and nothing audited as changed.
    expect(
      (await chainedAudit(db, await systemOrgId(db), 0, 100)).filter(
        (e) => e.op === "setting_changed",
      ),
    ).toEqual([]);
  });

  test("a bad value is refused naming the key; value and unset are exclusive", async () => {
    const inst = await instance();
    const bad = await run(rt(), inst, "instance_set_setting", { key: "backup_keep", value: 0 });
    expect(errOf(bad)).toMatchObject({ code: "invalid_input" });
    expect(errOf(bad)?.message).toContain("backup_keep");
    for (const input of [{ key: "backup_keep" }, { key: "backup_keep", value: 3, unset: true }]) {
      expect(errOf(await run(rt(), inst, "instance_set_setting", input))).toMatchObject({
        code: "invalid_input",
      });
    }
    expect(
      errOf(await run(rt(), inst, "instance_set_setting", { key: "nope", value: 1 })),
    ).toMatchObject({
      code: "not_found",
    });
  });

  test("scopes do not cross: org tokens cannot reach instance settings, nor the reverse", async () => {
    const r = rt();
    expect(errOf(await run(r, admin(), "get_setting", { key: "backup_keep" }))?.message).toContain(
      "instance setting",
    );
    expect(
      errOf(await run(r, admin(), "instance_get_setting", { key: "org_label" })),
    ).toMatchObject({
      code: "forbidden",
    });
    expect(
      errOf(
        await run(r, await instance(), "instance_set_setting", { key: "org_label", value: "x" }),
      )?.message,
    ).toContain("org setting");
  });

  test("the role check: the setting's own role, on top of the op's", async () => {
    const r = rt();
    const operator = await mintToken(db, a.scope, "operator");
    const op: Credential = { kind: "bearer", token: operator.secret };
    // org_label needs operator: an operator may.
    const ok = await run(r, op, "set_setting", { key: "org_label", value: "ops" });
    expect(ok.ok && ok.output).toMatchObject({ value: "ops", source: "db" });
    // org_limit needs admin: an operator token may not, a member admin may.
    const denied = await run(r, op, "set_setting", { key: "org_limit", value: 9 });
    expect(errOf(denied)).toMatchObject({ code: "forbidden" });
    expect(errOf(denied)?.message).toContain("admin");
    const allowed = await run(r, admin(), "set_setting", { key: "org_limit", value: 9 });
    expect(allowed.ok && allowed.output).toMatchObject({ value: 9, source: "db" });
    // A reader is below the op's own role, and is audited as denied.
    const reader = await mintToken(db, a.scope, "reader");
    const rd = await run(r, { kind: "bearer", token: reader.secret }, "set_setting", {
      key: "org_label",
      value: "x",
    });
    expect(errOf(rd)).toMatchObject({ code: "forbidden" });
  });

  test("over MCP a setting that is not mcpEditable is refused, with its reason", async () => {
    const r = rt();
    // The member admin passes the role check; only the transport differs.
    const mcp = await run(
      r,
      admin(),
      "set_setting",
      { key: "org_limit", value: 9 },
      { viaMcp: true },
    );
    expect(errOf(mcp)).toMatchObject({ code: "forbidden" });
    expect(errOf(mcp)?.message).toContain("over MCP");
    expect(errOf(mcp)?.message).toContain("it raises a limit");
    expect(
      (await resolveSetting(r, db, "org_limit", { orgId: a.orgId, orgSlug: "org-a" })).source,
    ).toBe("default");
    // An mcpEditable one goes through over MCP, and over REST the same refused one is the human's call.
    const label = await run(
      r,
      admin(),
      "set_setting",
      { key: "org_label", value: "m" },
      { viaMcp: true },
    );
    expect(label.ok).toBe(true);
    const rest = await run(r, admin(), "set_setting", { key: "org_limit", value: 9 });
    expect(rest.ok).toBe(true);
  });

  test("an org set is audited in the org's chain with old and new values", async () => {
    const r = rt();
    await run(r, admin(), "set_setting", { key: "org_label", value: "one" });
    await run(r, admin(), "set_setting", { key: "org_label", value: "two" });
    const rows = (await chainedAudit(db, a.orgId, 0, 100)).filter(
      (e) => e.op === "setting_changed",
    );
    expect(rows.map((e) => JSON.parse(e.input))).toEqual([
      { key: "org_label", from: "none", to: "one", source: "db" },
      { key: "org_label", from: "one", to: "two", source: "db" },
    ]);
  });

  test("a project setting needs a project, and is kept per project", async () => {
    const r = rt();
    const noProject = await run(r, admin(), "set_setting", { key: "project_note", value: "x" });
    expect(errOf(noProject)).toMatchObject({ code: "invalid_input" });
    const ok = await run(r, admin(), "set_setting", {
      key: "project_note",
      value: "x",
      project: a.projectSlug,
    });
    expect(ok.ok && ok.output).toMatchObject({ value: "x", scope: "project", source: "db" });
    const list = await run(r, admin(), "list_settings", { project: a.projectSlug });
    expect(
      list.ok && (list.output as { settings: { key: string }[] }).settings.map((s) => s.key),
    ).toEqual(["org_label", "org_limit", "project_note"]);
    const orgOnly = await run(r, admin(), "list_settings", {});
    expect(
      orgOnly.ok && (orgOnly.output as { settings: { key: string }[] }).settings.map((s) => s.key),
    ).toEqual(["org_label", "org_limit"]);
    // Paged by cursor, in key order.
    const first = await run(r, admin(), "list_settings", { project: a.projectSlug, limit: 2 });
    const page = first.ok ? (first.output as { next_cursor: string | null }) : undefined;
    expect(page?.next_cursor).toBe("org_limit");
    const next = await run(r, admin(), "list_settings", {
      project: a.projectSlug,
      limit: 2,
      cursor: "org_limit",
    });
    expect(
      next.ok && (next.output as { settings: { key: string }[] }).settings.map((s) => s.key),
    ).toEqual(["project_note"]);
    expect(next.ok && (next.output as { next_cursor: string | null }).next_cursor).toBeNull();
  });

  test("refusal order: a lock, then the role, then MCP, on every transport", async () => {
    const operator = await mintToken(db, a.scope, "operator");
    const op: Credential = { kind: "bearer", token: operator.secret };
    const set = (r: SettingsRuntime, cred: Credential, viaMcp: boolean) =>
      run(r, cred, "set_setting", { key: "org_limit", value: 9 }, { viaMcp });
    for (const viaMcp of [false, true]) {
      // Locked by the environment, and the caller has neither the role nor MCP: the lock is named.
      const env = errOf(await set(rt({ TT_TEST_ORG_LIMIT: "3" }), op, viaMcp));
      expect(env).toMatchObject({ code: "conflict" });
      expect(env?.message).toContain("TT_TEST_ORG_LIMIT");
      // A TOML value on a setting that is not mcpEditable is still a lock.
      const file = errOf(await set(rt({}, "[orgs.org-a.limits]\norg = 3"), op, viaMcp));
      expect(file).toMatchObject({ code: "conflict" });
      expect(file?.message).toContain("turntable.toml");
      // Not locked: the role comes before MCP.
      const role = errOf(await set(rt(), op, viaMcp));
      expect(role).toMatchObject({ code: "forbidden" });
      expect(role?.message).toContain("requires role admin");
    }
    // Allowed role, not locked, on MCP: the MCP reason.
    expect(errOf(await set(rt(), admin(), true))?.message).toContain("over MCP");
    expect((await set(rt(), admin(), false)).ok).toBe(true);
  });

  test("tenancy: another org's token cannot read or write this org's settings or projects", async () => {
    const r = rt();
    // Org C beside A and B, in the same database.
    const other = await seedTenant(db, "org-c");
    await run(r, admin(), "set_setting", { key: "org_label", value: "secret-a" });
    await run(r, admin(), "set_setting", {
      key: "project_note",
      value: "note-a",
      project: a.projectSlug,
    });
    const tokenC = await mintToken(db, other.scope, "operator");
    const c: Credential = { kind: "bearer", token: tokenC.secret };
    // Org C asks for org A's project by id and by slug-like values, and for a project that does not
    // exist: every one is the same refusal.
    const nonexistent = await run(r, c, "get_setting", { key: "project_note", project: "nope" });
    const refusal = errOf(nonexistent);
    expect(refusal).toBeDefined();
    for (const project of [a.projectId, "nope-at-all"]) {
      for (const [op, input] of [
        ["get_setting", { key: "project_note", project }],
        ["set_setting", { key: "project_note", value: "evil", project }],
        ["list_settings", { project }],
      ] as const) {
        expect(errOf(await run(r, c, op, input))).toEqual(refusal);
      }
    }
    // Org C's own reads and writes see their own values only.
    const own = await run(r, c, "get_setting", { key: "org_label" });
    expect(own.ok && own.output).toMatchObject({ value: "none", source: "default" });
    await run(r, c, "set_setting", { key: "org_label", value: "c-value" });
    const mine = await run(r, admin(), "get_setting", { key: "org_label" });
    expect(mine.ok && mine.output).toMatchObject({ value: "secret-a", source: "db" });
    const note = await resolveSetting(r, db, "project_note", {
      orgId: a.orgId,
      orgSlug: "org-a",
      projectId: a.projectId,
      projectSlug: a.projectSlug,
    });
    expect(note).toMatchObject({ value: "note-a" });
  });

  test("an org token's view of a locked file value does not leak the file path", async () => {
    const r = rt({}, "[orgs.org-a]\nlabel = 'L'");
    const got = await run(r, admin(), "get_setting", { key: "org_label" });
    expect(got.ok && got.output).toMatchObject({ source: "toml", locked: true, locked_by: "toml" });
  });
});

describe("org_id", () => {
  const row = (over: Record<string, unknown>) => ({
    scopeKind: "org",
    scopeId: "x",
    orgId: "x",
    key: "k",
    value: "1",
    updatedBy: "t",
    updatedAt: 1,
    ...over,
  });
  const insert = (over: Record<string, unknown>) =>
    db.run((h) => h.orm.insert(s.settings).values(row(over) as never));

  test("the CHECK: null only for instance scope, and an org row is about its own org", async () => {
    await expect(
      insert({ scopeKind: "instance", scopeId: "", orgId: null }),
    ).resolves.toBeDefined();
    await expect(
      insert({ scopeKind: "instance", scopeId: "", orgId: a.orgId, key: "k2" }),
    ).rejects.toThrow();
    await expect(insert({ scopeKind: "org", scopeId: a.orgId, orgId: null })).rejects.toThrow();
    const c = await seedTenant(db, "org-d");
    await expect(
      insert({ scopeKind: "org", scopeId: a.orgId, orgId: c.scope.orgId }),
    ).rejects.toThrow();
    await expect(
      insert({ scopeKind: "project", scopeId: a.projectId, orgId: null }),
    ).rejects.toThrow();
    await expect(
      insert({ scopeKind: "org", scopeId: a.orgId, orgId: a.orgId }),
    ).resolves.toBeDefined();
  });

  test("a project row's org must be the project's org, checked at write time", async () => {
    const c = await seedTenant(db, "org-e");
    const target = { kind: "project", id: a.projectId } as const;
    await expect(
      putStoredSetting(db, { ...target, orgId: c.scope.orgId }, "project_note", "x", "t", 1),
    ).rejects.toThrow(/not in org/);
    await putStoredSetting(db, { ...target, orgId: a.orgId }, "project_note", "x", "t", 1);
    expect(await getStoredSetting(db, { ...target, orgId: a.orgId }, "project_note")).toMatchObject(
      { value: "x" },
    );
    // Another org's id with the same scope id reaches nothing.
    expect(
      await getStoredSetting(db, { ...target, orgId: c.scope.orgId }, "project_note"),
    ).toBeUndefined();
    expect(await getStoredSetting(db, { ...target, orgId: null }, "project_note")).toBeUndefined();
  });

  test("the ops store the caller's org, and instance rows have none", async () => {
    const r = rt();
    await run(r, admin(), "set_setting", { key: "org_label", value: "v" });
    await run(r, await instance(), "instance_set_setting", { key: "backup_keep", value: 3 });
    const rows = await db.run((h) => h.orm.select().from(s.settings));
    expect(rows.map((x) => [x.scopeKind, x.orgId])).toEqual(
      expect.arrayContaining([
        ["org", a.orgId],
        ["instance", null],
      ]),
    );
  });
});

describe("registry wiring", () => {
  test("the settings ops are registered; the instance ones are not MCP tools, the org ones are", () => {
    for (const n of ["get_setting", "list_settings", "set_setting"]) {
      expect(registry.get(n)).toBeDefined();
      expect(registry.mcpOps().map((o) => o.name)).toContain(n);
    }
    for (const n of ["instance_get_setting", "instance_list_settings", "instance_set_setting"]) {
      expect(registry.get(n)?.auth.type).toBe("instance");
      expect(registry.mcpOps().map((o) => o.name)).not.toContain(n);
    }
  });

  test("backup_keep keeps its environment name", () => {
    expect(settingsRegistry.get("backup_keep")?.env).toEqual(["TURNTABLE_BACKUP_KEEP"]);
    expect(settingsRegistry.get("backup_keep")?.toml).toBe("backup.keep");
  });
});
