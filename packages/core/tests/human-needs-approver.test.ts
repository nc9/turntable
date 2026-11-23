// `untrusted_run_approval = human` needs an approver that counts (#407): every write path refuses
// it for an org with none, and doctor warns when a project on `human` later loses its approver.
// Runs on both dialects (TURNTABLE_TEST_DB).
import { beforeEach, describe, expect, test } from "bun:test";
import { generateEd25519 } from "../src/approvals/keys";
import {
  setKeyPolicy,
  getProjectSandboxSettings,
  insertApprover,
  revokeApprover,
} from "../src/db/repos";
import type { Db } from "../src/db";
import { runDoctor } from "../src/doctor/checks";
import { dispatch, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { setSandboxPolicy } from "../src/ops/policy-cli";
import { countHumanWithoutApprover, HUMAN_REQUIRES_APPROVER } from "../src/ops/setting-guard";
import { settingsRegistry } from "../src/settings/definitions";
import { loadSettingsRuntime } from "../src/settings/boot";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let secret: string;
const rt = (toml?: string) =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env: {},
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });

const enrol = (opts: { forgeLogin?: string | null; hardware?: boolean } = {}) =>
  insertApprover(
    db,
    a.scope.orgId,
    {
      person: "p",
      forgeLogin: opts.forgeLogin === undefined ? "p-gh" : opts.forgeLogin,
      kind: opts.hardware ? "webauthn" : "ed25519",
      publicKey: generateEd25519().publicSpki,
      alg: opts.hardware ? "ES256" : "EdDSA",
      createdBy: "test",
    },
    1,
  );
const setHuman = (settings = rt()) =>
  dispatch(
    { registry, db, settings, allowInstance: true },
    { kind: "bearer", token: secret },
    "set_project_settings",
    {
      target_org: "org-a",
      target_project: a.projectSlug,
      untrusted_run_approval: "human",
    },
  );
const viaSetSetting = () =>
  dispatch(
    { registry, db, settings: rt() },
    { kind: "principal", principal: { kind: "member", id: "o", orgId: a.orgId, role: "owner" } },
    "set_setting",
    { key: "untrusted_run_approval", project: a.projectSlug, value: "human" },
  );
const refused = (r: { ok: boolean; error?: { message: string } }) =>
  r.ok ? "" : (r.error?.message ?? "");

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

describe("refusing human without an approver", () => {
  test("zero approvers: refused on set_project_settings, set_setting and the CLI", async () => {
    for (const r of [await setHuman(), await viaSetSetting()]) {
      expect(r.ok).toBe(false);
      expect(refused(r)).toContain("human_requires_approver");
    }
    await expect(
      setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "human" }, rt()),
    ).rejects.toThrow(HUMAN_REQUIRES_APPROVER);
    expect((await getProjectSandboxSettings(db, a.scope))?.untrustedRunApproval).not.toBe("human");
  });

  test("only a revoked approver: refused", async () => {
    const ap = await enrol();
    await revokeApprover(db, a.scope.orgId, ap.id, 2);
    expect((await setHuman()).ok).toBe(false);
  });

  test("a key with no forge login does not count", async () => {
    await enrol({ forgeLogin: null });
    expect((await setHuman()).ok).toBe(false);
  });

  test("hardware policy with only a non-hardware key: refused", async () => {
    await enrol();
    await setKeyPolicy(db, a.scope.orgId, { mode: "hardware", presets: [], aaguids: [] }, "t", 3);
    const r = await setHuman();
    expect(r.ok).toBe(false);
    expect(refused(r)).not.toContain("p-gh");
  });

  test("a valid approver: accepted on every path", async () => {
    await enrol();
    expect((await setHuman()).ok).toBe(true);
    expect((await viaSetSetting()).ok).toBe(true);
    await setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "human" }, rt());
  });

  test("other values are not gated", async () => {
    const r = await dispatch(
      { registry, db, settings: rt(), allowInstance: true },
      { kind: "bearer", token: secret },
      "set_project_settings",
      { target_org: "org-a", target_project: a.projectSlug, untrusted_run_approval: "any" },
    );
    expect(r.ok).toBe(true);
  });
});

describe("doctor human_approval_approvers", () => {
  const check = async (settings = rt()) => {
    const { realInputs } = await import("../src/doctor/real");
    const { inputs } = realInputs({
      env: {},
      dataDir: "/nonexistent",
      hosted: false,
      humanApprovalGaps: () => countHumanWithoutApprover(settings, db),
    });
    const r = await runDoctor({ ...inputs, db: undefined, openError: "missing" });
    return r.checks.find((c) => c.id === "human_approval_approvers")!;
  };

  test("passes with no project on human", async () => {
    expect((await check()).status).toBe("pass");
  });

  test("warns after the approver is revoked, with a fixed sentence", async () => {
    const ap = await enrol();
    expect((await setHuman()).ok).toBe(true);
    expect((await check()).status).toBe("pass");
    await revokeApprover(db, a.scope.orgId, ap.id, 5);
    const c = await check();
    expect(c.status).toBe("warn");
    expect(JSON.stringify(c)).not.toMatch(/org-a|app\b|p-gh/);
  });

  test("warns for a turntable.toml value of human with no approver", async () => {
    const toml = `[orgs.org-a.projects.app]\nuntrusted_run_approval = "human"\n`;
    expect((await check(rt(toml))).status).toBe("warn");
    await enrol();
    expect((await check(rt(toml))).status).toBe("pass");
  });
});
