// `checks_mode` as a registry setting (onboarding lane A3). It is backed by the same
// `projects.checks_mode` column the reporter has always read, so no existing project changes mode.
// The states built here: a project nobody set (binding-only, `off`), one set to `shadow` and one
// to `live` through the CLI's setter.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createProject, getProjectChecksMode, setProjectChecksMode } from "../src/db";
import { bindRepo } from "../src/db";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { dispatch, registry, type Principal } from "../src/ops";
import * as schema from "../src/db/schema";
import { upsertInstallation, countRunningByMode } from "../src/db/repos";
import type { GithubFacts } from "../src/github/api";
import { effectiveChecksMode } from "../src/ops/setting-guard";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { loadTomlSettings } from "../src/settings/toml";
import { setupChecksWorld } from "./checks-helpers";

function fakeApi() {
  const created: CheckRunBody[] = [];
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      created.push(body);
      return String(100 + created.length);
    },
    async update() {},
    async findByExternalId() {
      return undefined;
    },
  };
  return { api, created };
}
const auth: TokenMinter = { mint: async () => ({ token: "stub-installation-token" }) };

describe("checks_mode keeps every existing project's effective mode", () => {
  test("a project nobody set (off), a shadow one and a live one are unchanged", async () => {
    const w = await setupChecksWorld();
    const mk = async (slug: string, repo: string, mode: "off" | "shadow" | "live") => {
      const p = await createProject(w.db, { orgId: w.org.id }, { slug, name: slug });
      const scope = { orgId: w.org.id, projectId: p.id };
      await bindRepo(w.db, scope, { forge: "github", owner: "acme", repo, installationId: "9001" });
      // The pre-change way a mode got set: the column, through the CLI's setter.
      if (mode !== "off") await setProjectChecksMode(w.db, scope, mode);
      return { ...scope, slug };
    };
    const states = [
      { scope: await mk("bound-only", "a", "off"), was: "off" },
      { scope: await mk("was-shadow", "b", "shadow"), was: "shadow" },
      { scope: await mk("was-live", "c", "live"), was: "live" },
    ] as const;
    for (const s of states) {
      // What the reporter read before this change.
      expect(await getProjectChecksMode(w.db, s.scope)).toBe(s.was);
      // What it reads now, with no lock layer and with an empty file layer.
      expect(await effectiveChecksMode(undefined, w.db, s.scope.orgId, s.scope.projectId)).toBe(
        s.was,
      );
      const rt = createSettingsRuntime(
        settingsRegistry,
        {},
        loadTomlSettings(undefined, settingsRegistry),
      );
      expect(await effectiveChecksMode(rt, w.db, s.scope.orgId, s.scope.projectId)).toBe(s.was);
    }
    // And through the registry op: the value, and that an untouched project has nothing stored.
    const org = { kind: "member", id: "m", orgId: w.org.id, role: "admin" } as const;
    for (const s of states) {
      const r = await dispatch(
        { registry, db: w.db },
        { kind: "principal", principal: org },
        "get_setting",
        { key: "checks_mode", project: s.scope.slug },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.output).toMatchObject({
          value: s.was,
          source: s.was === "off" ? "default" : "db",
          locked: false,
        });
      }
    }
  });
});

describe("the reporter follows the effective mode", () => {
  const post = async (
    mode: "off" | "shadow" | "live",
    settings?: ReturnType<typeof createSettingsRuntime>,
  ) => {
    const w = await setupChecksWorld();
    if (mode !== "off") await setProjectChecksMode(w.db, w.scope, mode);
    const { api, created } = fakeApi();
    const reporter = new CheckReporter({ db: w.db, auth, api, sleep: async () => {}, settings });
    reporter.started(await w.claim());
    await reporter.idle();
    return created;
  };

  test("off posts nothing", async () => {
    expect(await post("off")).toEqual([]);
  });

  test("shadow posts neutral `shadow /` checks", async () => {
    const [c] = await post("shadow");
    expect(c?.name).toStartWith("shadow / ");
  });

  test("live posts `turntable /` checks", async () => {
    const [c] = await post("live");
    expect(c?.name).toStartWith("turntable / ");
  });

  test("a turntable.toml value locks the mode and wins over the stored one", async () => {
    // Stored live, file says off: nothing is posted. (The org and project slugs key the file.)
    const toml = loadTomlSettings("t.toml", settingsRegistry, () =>
      ["[orgs.acme.projects.app]", 'checks_mode = "off"'].join("\n"),
    );
    const rt = createSettingsRuntime(settingsRegistry, {}, toml);
    expect(await post("live", rt)).toEqual([]);
    // And file says live over a stored shadow.
    const live = createSettingsRuntime(
      settingsRegistry,
      {},
      loadTomlSettings("t.toml", settingsRegistry, () =>
        ["[orgs.acme.projects.app]", 'checks_mode = "live"'].join("\n"),
      ),
    );
    expect((await post("shadow", live))[0]?.name).toStartWith("turntable / ");
  });
});

describe("changing it", () => {
  test("a stored change writes the column, so the CLI and the registry agree", async () => {
    const w = await setupChecksWorld();
    const admin = { kind: "member", id: "m", orgId: w.org.id, role: "admin" } as const;
    const res = await dispatch(
      { registry, db: w.db },
      { kind: "principal", principal: admin },
      "set_setting",
      { key: "checks_mode", project: "app", value: "shadow" },
    );
    expect(res.ok).toBe(true);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("shadow");
    const back = await dispatch(
      { registry, db: w.db },
      { kind: "principal", principal: admin },
      "set_setting",
      { key: "checks_mode", project: "app", unset: true },
    );
    expect(back.ok).toBe(true);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("off");
  });

  test("setting live needs owner or admin: an operator or a member is refused", async () => {
    const w = await setupChecksWorld();
    const principals: Principal[] = [
      { kind: "member", id: "m", orgId: w.org.id, role: "member" },
      {
        kind: "token",
        id: "t",
        orgId: w.org.id,
        projectId: null,
        role: "operator",
        tokenKind: "person",
      },
    ];
    for (const principal of principals) {
      const res = await dispatch(
        { registry, db: w.db },
        { kind: "principal", principal },
        "set_setting",
        { key: "checks_mode", project: "app", value: "live" },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("forbidden");
    }
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("off");
  });

  test("a locked value refuses the change and says where it is set", async () => {
    const w = await setupChecksWorld();
    const toml = loadTomlSettings("t.toml", settingsRegistry, () =>
      ["[orgs.acme.projects.app]", 'checks_mode = "off"'].join("\n"),
    );
    const res = await dispatch(
      { registry, db: w.db, settings: createSettingsRuntime(settingsRegistry, {}, toml) },
      {
        kind: "principal",
        principal: { kind: "member", id: "m", orgId: w.org.id, role: "owner" },
      },
      "set_setting",
      { key: "checks_mode", project: "app", value: "live" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("locked");
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("off");
  });
});

const lockedOff = () =>
  createSettingsRuntime(
    settingsRegistry,
    {},
    loadTomlSettings("t.toml", settingsRegistry, () =>
      ["[orgs.acme.projects.app]", 'checks_mode = "off"'].join("\n"),
    ),
  );

describe("onboard_repos picks the mode", () => {
  const setup = async () => {
    const w = await setupChecksWorld();
    await upsertInstallation(
      w.db,
      { orgId: w.org.id },
      {
        installationId: w.installationId,
        appId: "42",
        accountLogin: "acme",
        accountId: "7",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
      },
    );
    await w.db.run((h) => h.orm.update(schema.projectRepos).set({ forgeRepoId: "1001" }));
    const githubFacts: GithubFacts = {
      getInstallation: async () => undefined,
      listInstallationRepos: async () => [
        {
          id: "1001",
          name: "web",
          owner: "acme",
          fullName: "acme/web",
          private: true,
          defaultBranch: "main",
        },
      ],
    };
    const onboard = (role: "owner" | "member", mode?: string) =>
      dispatch(
        { registry, db: w.db, githubFacts },
        {
          kind: "principal",
          principal: { kind: "session", id: "u1", orgId: w.org.id, role },
        },
        "onboard_repos",
        {
          installation_id: w.installationId,
          repos: [{ repo_id: "1001", enable: true, ...(mode ? { mode } : {}) }],
        },
      );
    return { w, onboard };
  };

  test("no mode chosen is off, and the reporter posts nothing", async () => {
    const { w, onboard } = await setup();
    expect((await onboard("owner")).ok).toBe(true);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("off");
    const { api, created } = fakeApi();
    const reporter = new CheckReporter({ db: w.db, auth, api, sleep: async () => {} });
    reporter.started(await w.claim());
    await reporter.idle();
    expect(created).toEqual([]);
  });

  test("shadow and live each set the column; live still needs owner or admin", async () => {
    const { w, onboard } = await setup();
    expect((await onboard("owner", "shadow")).ok).toBe(true);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("shadow");
    expect((await onboard("owner", "live")).ok).toBe(true);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("live");
    const refused = await onboard("member", "off");
    expect(refused.ok).toBe(false);
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("live");
  });
});

describe("a turntable.toml lock on checks_mode", () => {
  test("the host CLI refuses to set it, with the lock reason, and changes nothing", async () => {
    const w = await setupChecksWorld();
    const { setChecksModePolicy, showChecksMode } = await import("../src/ops/policy-cli");
    await expect(setChecksModePolicy(w.db, "acme", "app", "live", lockedOff())).rejects.toThrow(
      /locked.*turntable\.toml/,
    );
    expect(await getProjectChecksMode(w.db, w.scope)).toBe("off");
    // Without a lock the same call works, and show reports the effective (locked) value.
    await setProjectChecksMode(w.db, w.scope, "live");
    expect(await showChecksMode(w.db, "acme", lockedOff())).toEqual([
      { project: "app", mode: "off" },
    ]);
  });

  test("drain counts use the effective mode, not the stored column", async () => {
    const w = await setupChecksWorld();
    await setProjectChecksMode(w.db, w.scope, "live");
    const c = await w.claim();
    await w.db.run((h) =>
      h.orm
        .update(schema.jobAttempts)
        .set({ state: "running" })
        .where(eq(schema.jobAttempts.id, c.attempt.id)),
    );
    expect(await countRunningByMode(w.db)).toEqual({ live: 1, shadow: 0 });
    const rt = lockedOff();
    expect(await countRunningByMode(w.db, (o, p) => effectiveChecksMode(rt, w.db, o, p))).toEqual({
      live: 0,
      shadow: 1,
    });
  });
});
