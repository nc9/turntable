import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createFixture } from "../src/api/fixture/adapter";
import { createFixtureSettings } from "../src/api/fixture/settings";
import { createHttpApi, mapSetting } from "../src/api/http-adapter";
import type { Setting } from "../src/api/types";
import type { WireSetting } from "../src/api/wire";
import { SettingsPanel, type SettingsPanelProps } from "../src/features/settings/settings-panel";
import { editability, lockNote, loosens, saveSetting, valueOfDraft } from "../src/lib/settings";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const wire = (over: Partial<WireSetting> = {}): WireSetting => ({
  key: "log_retention_days",
  scope: "org",
  description: "How many days logs are kept before they are deleted.",
  value: 30,
  default: 30,
  source: "default",
  locked: false,
  locked_by: null,
  role: "admin",
  mcp_editable: false,
  strictness: null,
  warning: null,
  ...over,
});

const setting = (over: Partial<Setting> = {}): Setting => ({
  key: "log_retention_days",
  scope: "org",
  description: "How many days logs are kept before they are deleted.",
  value: 30,
  default: 30,
  source: "default",
  locked: false,
  lockedBy: null,
  role: "admin",
  mcpEditable: false,
  warning: null,
  ...over,
});

const panel = (over: Partial<SettingsPanelProps> = {}): string =>
  renderToStaticMarkup(
    <SettingsPanel
      settings={[setting()]}
      role="owner"
      drafts={{}}
      errors={{}}
      busy={null}
      onDraft={() => {}}
      onSave={() => {}}
      onReset={() => {}}
      {...over}
    />,
  );

describe("http adapter", () => {
  function make(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input), "http://localhost");
        calls.push({ url, init });
        return handler(url, init);
      }) as typeof fetch,
    });
    return { api, calls };
  }

  test("listSettings reads every page and maps the fields", async () => {
    const { api, calls } = make((url) =>
      url.searchParams.get("cursor") === null
        ? json({ settings: [wire({ key: "a" })], next_cursor: "a" })
        : json({
            settings: [wire({ key: "b", source: "env", locked: true, locked_by: "TURNTABLE_B" })],
            next_cursor: null,
          }),
    );
    const out = await api.listSettings();
    expect(out.map((s) => s.key)).toEqual(["a", "b"]);
    expect(out[1]).toMatchObject({ source: "env", locked: true, lockedBy: "TURNTABLE_B" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/settings");
    expect(calls[0]!.url.searchParams.get("org")).toBe("acme");
    expect(calls[0]!.url.searchParams.has("project")).toBe(false);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("a");
  });

  test("a project list asks for the project and keeps only its own settings", async () => {
    const { api, calls } = make(() =>
      json({
        settings: [wire({ key: "org_one" }), wire({ key: "proj_one", scope: "project" })],
        next_cursor: null,
      }),
    );
    expect((await api.listSettings({ project: "api" })).map((s) => s.key)).toEqual(["proj_one"]);
    expect(calls[0]!.url.searchParams.get("project")).toBe("api");
  });

  test("setSetting posts the value or unset, and rejects with the server's message", async () => {
    const { api, calls } = make((_url, init) => {
      const body = JSON.parse(String(init.body)) as { value?: unknown };
      return body.value === 0
        ? json({ error: { code: "invalid_input", message: "log_retention_days: too small" } }, 400)
        : json(wire({ value: 7, source: "db" }));
    });
    expect((await api.setSetting({ key: "log_retention_days", value: 7 })).source).toBe("db");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      org: "acme",
      key: "log_retention_days",
      value: 7,
    });
    await api.setSetting({ key: "log_retention_days", unset: true, project: "api" });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      org: "acme",
      key: "log_retention_days",
      project: "api",
      unset: true,
    });
    await expect(api.setSetting({ key: "log_retention_days", value: 0 })).rejects.toThrow(
      "log_retention_days: too small",
    );
  });
});

describe("rendering", () => {
  test("each source gets its badge", () => {
    for (const [source, label] of [
      ["env", "env"],
      ["toml", "toml"],
      ["db", "ui/db"],
      ["default", "default"],
    ] as const) {
      const html = panel({ settings: [setting({ source })] });
      expect(html).toContain(`data-source="${source}"`);
      expect(html).toContain(`>${label}</span>`);
    }
  });

  test("an env-locked setting is read-only and names the variable", () => {
    const html = panel({
      settings: [setting({ source: "env", locked: true, lockedBy: "TURNTABLE_LOG_DAYS" })],
    });
    expect(html).toContain("Set by TURNTABLE_LOG_DAYS");
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).not.toContain("Reset to default");
  });

  test("a toml-locked setting says it is set in turntable.toml", () => {
    const html = panel({ settings: [setting({ source: "toml", locked: true, lockedBy: "toml" })] });
    expect(html).toContain("Set in turntable.toml");
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });

  test("a setting that can weaken a protection shows its warning, and others show none", () => {
    const text = "Lowering this weakens human approval.";
    const html = panel({ settings: [setting({ key: "approval_policy", warning: text })] });
    expect(html).toContain('data-warning="approval_policy"');
    expect(html).toContain(text);
    expect(panel()).not.toContain("data-warning");
    expect(mapSetting(wire({ warning: text })).warning).toBe(text);
    expect(mapSetting(wire()).warning).toBeNull();
  });

  test("a refusal is shown verbatim", () => {
    const msg = "log_retention_days: Too small: expected number to be >=1";
    const html = panel({ errors: { log_retention_days: msg } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("log_retention_days: Too small: expected number to be &gt;=1</p>");
  });

  test("controls follow the role", () => {
    const edited = { drafts: { log_retention_days: "45" } };
    const owner = panel({ ...edited, role: "owner" });
    expect(owner).not.toMatch(/<input[^>]*disabled=""/);
    expect(owner).toContain(">Save</button>");
    const reader = panel({ ...edited, role: "reader" });
    expect(reader).toMatch(/<input[^>]*disabled=""/);
    expect(reader).not.toContain(">Save</button>");
    expect(reader).toContain("Changing this needs the admin role or higher");
    // A stored value can be reset by someone who may edit it, and by nobody else.
    const stored = setting({ source: "db", value: 10 });
    expect(panel({ settings: [stored], role: "admin" })).toContain("Reset to default");
    expect(panel({ settings: [stored], role: "operator" })).not.toContain("Reset to default");
  });

  test("a boolean setting is a select, and the effective value is shown", () => {
    const html = panel({
      settings: [setting({ key: "cache_enabled", default: true, value: false, source: "db" })],
    });
    expect(html).toContain("<select");
    expect(html).toContain("effective false");
  });
});

describe("a setting that may only be tightened", () => {
  const strict = (over: Partial<Setting> = {}) =>
    setting({
      key: "untrusted_run_approval",
      scope: "project",
      role: "owner",
      value: "no_agents",
      default: "any",
      source: "db",
      strictness: ["any", "no_agents", "human"],
      ...over,
    });

  test("the adapter maps the order, and null stays absent", async () => {
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async () =>
        json({
          settings: [
            wire({ key: "a", strictness: ["any", "no_agents", "human"] }),
            wire({ key: "b" }),
          ],
          next_cursor: null,
        })) as unknown as typeof fetch,
    });
    const [a, b] = await api.listSettings();
    expect(a!.strictness).toEqual(["any", "no_agents", "human"]);
    expect(b!.strictness).toBeUndefined();
  });

  test("a value looser than the effective one is a loosening", () => {
    expect(loosens(strict(), "any")).toBe(true);
    expect(loosens(strict(), "no_agents")).toBe(false);
    expect(loosens(strict(), "human")).toBe(false);
    expect(loosens(setting(), 1)).toBe(false);
  });

  test("looser options are disabled, and reset is disabled when the default is looser", () => {
    const html = panel({ settings: [strict()] });
    expect(html).toMatch(/<option value="any" disabled=""/);
    expect(html).not.toMatch(/<option value="no_agents" disabled/);
    expect(html).not.toMatch(/<option value="human" disabled/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reset to default/);
  });

  test("nothing is disabled when the effective value is the loosest", () => {
    const html = panel({ settings: [strict({ value: "any" })] });
    expect(html).not.toMatch(/<option [^>]*disabled/);
  });
});

describe("helpers", () => {
  test("lock notes", () => {
    expect(lockNote(setting())).toBeNull();
    expect(lockNote(setting({ locked: true, source: "env", lockedBy: "TURNTABLE_X" }))).toBe(
      "Set by TURNTABLE_X",
    );
    expect(lockNote(setting({ locked: true, source: "toml", lockedBy: "toml" }))).toBe(
      "Set in turntable.toml",
    );
  });

  test("operator is the floor even for a setting that asks for less", () => {
    const s = setting({ role: "reader" });
    expect(editability("reader", s).editable).toBe(false);
    expect(editability("operator", s).editable).toBe(true);
    expect(editability(null, s).editable).toBe(false);
  });

  test("a draft that does not read as its kind goes to the server as typed", () => {
    expect(valueOfDraft(setting(), "45")).toBe(45);
    expect(valueOfDraft(setting(), "abc")).toBe("abc");
    expect(valueOfDraft(setting(), "")).toBe("");
    expect(valueOfDraft(setting({ default: "x" }), "45")).toBe("45");
    expect(valueOfDraft(setting({ default: true }), "false")).toBe(false);
  });
});

describe("saving against the fixture", () => {
  const owner = createFixtureSettings(() => "owner");

  test("a good value is stored, then reset", async () => {
    const s = owner.list().find((x) => x.key === "log_retention_days")!;
    const saved = await saveSetting(async (a) => owner.set(a), s, { draft: "45" });
    expect(saved).toMatchObject({ ok: true, setting: { value: 45, source: "db" } });
    const reset = await saveSetting(async (a) => owner.set(a), s, { unset: true });
    expect(reset).toMatchObject({ ok: true, setting: { value: 30, source: "default" } });
  });

  test("validation, lock and role refusals come back unchanged", async () => {
    const list = owner.list();
    const bad = await saveSetting(async (a) => owner.set(a), list[0]!, { draft: "0" });
    expect(bad).toEqual({
      ok: false,
      message: "log_retention_days: Too small: expected number to be >=1",
    });
    const locked = list.find((x) => x.locked && x.source === "env")!;
    expect(await saveSetting(async (a) => owner.set(a), locked, { draft: "2" })).toEqual({
      ok: false,
      message: `${locked.key} is locked: it is set by the environment (TURNTABLE_MAX_PARALLEL_JOBS); change it there`,
    });
    const operator = createFixtureSettings(() => "operator");
    expect(await saveSetting(async (a) => operator.set(a), list[0]!, { draft: "9" })).toEqual({
      ok: false,
      message: "changing log_retention_days requires role admin",
    });
  });

  test("the fixture api lists org and project settings apart", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 60_000, seed: "s1" });
    try {
      expect((await fx.api.listSettings()).every((s) => s.scope === "org")).toBe(true);
      const proj = await fx.api.listSettings({ project: "api" });
      expect(proj.length).toBeGreaterThan(0);
      expect(proj.every((s) => s.scope === "project")).toBe(true);
    } finally {
      fx.stop();
    }
  });
});
