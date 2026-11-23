// `approval_policy` on the settings registry (#345): an environment's approval policy is set
// without a shell, by the instance administrator or by turntable.toml, and the CLI and the
// approval engine read and write it through the one resolver. Runs on both dialects.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsCommand } from "../src/approvals/cli";
import { approvalPolicyLoosening } from "../src/approvals/policy-setting";
import { systemOrgId } from "../src/audit/failures";
import {
  createOrg,
  type Db,
  getEnvPolicy,
  listAudit,
  listEnvPolicies,
  listEvents,
  openDatabase,
  setEnvPolicy,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { setAmbientSettings } from "../src/settings/ambient";
import { loadSettingsRuntime } from "../src/settings/boot";
import { approvalPolicySetting, settingsRegistry } from "../src/settings/definitions";
import { resolveSetting, type SettingsRuntime } from "../src/settings/resolve";
import { SettingsConfigError } from "../src/settings/toml";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const KEY = "approval_policy";
const rt = (toml?: string, env: Record<string, string> = {}): SettingsRuntime =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env,
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });
const SOLO = `[orgs.org-a.approval_policy.release]\nrequired = 1\nallow_author_approval = true\n`;
const solo = { required: 1, allow_author_approval: true, key_policy: "any" as const };

let db: Db;
let a: Tenant;
let b: Tenant;
let instanceSecret: string;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  instanceSecret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});
afterEach(() => setAmbientSettings(undefined));

const asInstance = (settings: SettingsRuntime, input: Record<string, unknown>) =>
  dispatch(
    { registry, db, settings, allowInstance: true } as DispatchEnv,
    { kind: "bearer", token: instanceSecret },
    "instance_set_setting",
    { key: KEY, target_org: "org-a", ...input },
  );

async function asToken(
  settings: SettingsRuntime,
  op: string,
  input: Record<string, unknown>,
  role: "reader" | "operator" | "release_operator",
  opts: { viaMcp?: boolean } = {},
) {
  const { secret } = await mintToken(db, a.scope, role, { kind: "person" });
  return dispatch(
    { registry, db, settings, ...(opts.viaMcp ? { viaMcp: true } : {}) },
    { kind: "bearer", token: secret },
    op,
    input,
  );
}

describe("the definition", () => {
  test("is an org setting only the instance administrator sets, never MCP, with an env var and a toml path", () => {
    expect(settingsRegistry.get(KEY)).toMatchObject({
      scope: "org",
      default: {},
      instanceAdminOnly: true,
      mcpEditable: false,
      env: ["TURNTABLE_APPROVAL_POLICY"],
      toml: "approval_policy",
    });
  });

  test("validates the count against the cap and the key policy against the enum", () => {
    const t = approvalPolicySetting.type;
    expect(t.safeParse({ release: { required: 1 } }).success).toBe(true);
    expect(t.safeParse({ release: { required: 0 } }).success).toBe(false);
    expect(t.safeParse({ release: { required: 11 } }).success).toBe(false);
    expect(t.safeParse({ release: { required: 2, key_policy: "weak" } }).success).toBe(false);
    expect(t.safeParse({ release: { required: 2, extra: 1 } }).success).toBe(false);
    expect(t.safeParse({ release: { required: 2, key_policy: "hardware" } }).success).toBe(true);
  });

  test("turntable.toml and the environment refuse a bad value at boot, naming the setting", () => {
    expect(() => rt(`[orgs.org-a.approval_policy.release]\nrequired = 0\n`)).toThrow(
      SettingsConfigError,
    );
    expect(() => rt(`[orgs.org-a.approval_policy.release]\nrequired = 11\n`)).toThrow(
      /approval_policy/,
    );
    expect(() => rt("", { TURNTABLE_APPROVAL_POLICY: "not json" })).toThrow(
      /TURNTABLE_APPROVAL_POLICY \(setting approval_policy\)/,
    );
    expect(() =>
      rt("", { TURNTABLE_APPROVAL_POLICY: '{"release":{"required":2,"key_policy":"x"}}' }),
    ).toThrow(SettingsConfigError);
  });
});

describe("layers", () => {
  const subject = () => ({ orgId: a.orgId, orgSlug: "org-a" });

  test("turntable.toml sets solo for release for its own org and locks it", async () => {
    const r = await resolveSetting(rt(SOLO), db, KEY, subject());
    expect(r).toMatchObject({ value: { release: solo }, source: "toml", locked: true });
    expect(await getEnvPolicy(db, a.orgId, "release", rt(SOLO))).toMatchObject({
      required: 1,
      allowAuthorApproval: true,
      gated: true,
      source: "configured",
      locked: true,
    });
    // org B has no entry: the default two
    expect(await getEnvPolicy(db, b.orgId, "release", rt(SOLO))).toMatchObject({
      required: 2,
      allowAuthorApproval: false,
      source: "default",
    });
  });

  test("the environment beats turntable.toml, and both beat the database", async () => {
    await setEnvPolicy(db, a.orgId, {
      environment: "release",
      required: 3,
      allowAuthorApproval: false,
      by: "t",
      now: 1,
    });
    expect((await getEnvPolicy(db, a.orgId, "release", rt())).required).toBe(3);
    expect((await getEnvPolicy(db, a.orgId, "release", rt(SOLO))).required).toBe(1);
    const both = rt(SOLO, { TURNTABLE_APPROVAL_POLICY: '{"release":{"required":2}}' });
    expect(await getEnvPolicy(db, a.orgId, "release", both)).toMatchObject({
      required: 2,
      locked: true,
    });
  });

  test("a stored policy that is no longer valid is ignored, so the default two applies", async () => {
    const { putStoredSetting } = await import("../src/db/repos/settings");
    await putStoredSetting(
      db,
      { kind: "org", id: a.orgId, orgId: a.orgId },
      KEY,
      { release: { required: 0 } },
      "t",
      1,
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await getEnvPolicy(db, a.orgId, "release", rt())).required).toBe(2);
    } finally {
      console.warn = warn;
    }
  });
});

describe("who may set it", () => {
  const value = { release: solo };

  test("an org token of any role is refused", async () => {
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const r = await asToken(rt(), "set_setting", { key: KEY, value }, role);
      expect(r.ok).toBe(false);
      if (!r.ok && role !== "reader")
        expect(r.error.message).toBe(`only the instance administrator can change ${KEY}`);
    }
    expect((await getEnvPolicy(db, a.orgId, "release", rt())).required).toBe(2);
  });

  test("MCP is refused", async () => {
    const r = await asToken(rt(), "set_setting", { key: KEY, value }, "release_operator", {
      viaMcp: true,
    });
    expect(r.ok).toBe(false);
    const viaInstance = await dispatch(
      { registry, db, settings: rt(), allowInstance: true, viaMcp: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, target_org: "org-a", value },
    );
    expect(viaInstance.ok).toBe(false);
    expect((await getEnvPolicy(db, a.orgId, "release", rt())).required).toBe(2);
  });

  test("the instance administrator sets it, and the engine reads it", async () => {
    const r = await asInstance(rt(), { value });
    expect(r.ok).toBe(true);
    expect(await getEnvPolicy(db, a.orgId, "release", rt())).toMatchObject({
      required: 1,
      allowAuthorApproval: true,
    });
    expect((await getEnvPolicy(db, b.orgId, "release", rt())).required).toBe(2);
    const missing = await asInstance(rt(), { value, target_org: "nope" });
    expect(!missing.ok && missing.error.code).toBe("not_found");
    const bad = await asInstance(rt(), { value: { release: { required: 0 } } });
    expect(!bad.ok && bad.error.code).toBe("invalid_input");
  });

  test("a lock refuses the instance administrator too, naming where it is set", async () => {
    const r = await asInstance(rt(SOLO), { value: {} });
    expect(!r.ok && r.error.message).toMatch(/locked: it is set by turntable.toml/);
    const e = await asInstance(rt("", { TURNTABLE_APPROVAL_POLICY: "{}" }), { value: {} });
    expect(!e.ok && e.error.message).toMatch(/the environment \(TURNTABLE_APPROVAL_POLICY\)/);
  });

  test("the setting is listed with its warning, source and lock", async () => {
    const r = await asToken(rt(SOLO), "get_setting", { key: KEY }, "reader");
    expect(r.ok && r.output).toMatchObject({
      key: KEY,
      source: "toml",
      locked: true,
      role: "instance_admin",
      mcp_editable: false,
      value: { release: solo },
    });
    expect((r.ok && (r.output as { warning: string }).warning) || "").toMatch(/weakens/);
  });
});

describe("loosening", () => {
  test("the rule: fewer approvers, the author, any key, or no longer gated", () => {
    const two = { required: 2, allow_author_approval: false, key_policy: "any" as const };
    expect(approvalPolicyLoosening({}, { release: two })).toEqual([]);
    expect(approvalPolicyLoosening({}, { release: solo })).toEqual([
      "release: approvers required 2 -> 1 (one person can approve alone)",
      "release: the author of a run may approve it",
    ]);
    expect(approvalPolicyLoosening({ release: solo }, {})).toEqual([]);
    expect(
      approvalPolicyLoosening(
        { release: { ...two, key_policy: "hardware" } },
        { release: { ...two, required: 3 } },
      ),
    ).toEqual(["release: any key may approve, not only hardware keys"]);
    expect(approvalPolicyLoosening({ staging: two }, {})).toEqual([
      "staging: no longer waits for approval",
    ]);
    // tightening is not loosening
    expect(
      approvalPolicyLoosening({ release: solo }, { release: { ...two, required: 3 } }),
    ).toEqual([]);
  });

  test("a loosening set is audited in the system chain and the org chain, and emits an event", async () => {
    const system = await systemOrgId(db);
    const r = await asInstance(rt(), { value: { release: solo } });
    expect(r.ok).toBe(true);
    for (const orgId of [system, a.orgId]) {
      const rows = (await listAudit(db, { orgId })).filter((x) => x.op === "setting_changed");
      expect(rows).toHaveLength(1);
      const input = JSON.parse(rows[0]!.input);
      expect(input).toMatchObject({
        key: KEY,
        from: {},
        to: { release: solo },
        source: "db",
        loosened: [
          "release: approvers required 2 -> 1 (one person can approve alone)",
          "release: the author of a run may approve it",
        ],
      });
    }
    const events = await listEvents(
      db,
      { orgId: a.orgId },
      {
        after: 0,
        limit: 10,
        types: ["approval.policy_loosened"],
      },
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ setting: KEY });
    // org B sees nothing
    expect(
      await listEvents(
        db,
        { orgId: b.orgId },
        { after: 0, limit: 10, types: ["approval.policy_loosened"] },
      ),
    ).toEqual([]);
  });

  test("a tightening set is audited without the mark and emits no event", async () => {
    const r = await asInstance(rt(), {
      value: { production: { required: 3, key_policy: "hardware" } },
    });
    expect(r.ok).toBe(true);
    const rows = (await listAudit(db, { orgId: a.orgId })).filter(
      (x) => x.op === "setting_changed",
    );
    expect(JSON.parse(rows[0]!.input)).not.toHaveProperty("loosened");
    expect(
      await listEvents(
        db,
        { orgId: a.orgId },
        { after: 0, limit: 10, types: ["approval.policy_loosened"] },
      ),
    ).toEqual([]);
  });
});

describe("the CLI and the engine share the resolver", () => {
  async function cli(args: string[], dir: string, config?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (m: string) => void out.push(m);
    console.error = (m: string) => void err.push(m);
    try {
      const code = await approvalsCommand([
        ...args,
        "--org",
        "cli-org",
        "--data-dir",
        dir,
        ...(config ? ["--config", config] : []),
      ]);
      return { code, out, err };
    } finally {
      [console.log, console.error] = [log, error];
    }
  }

  test("`approvals policy` writes the setting, audits it, and the engine reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-policy-"));
    const file = openDatabase(join(dir, "turntable.db"));
    const org = await createOrg(file, { slug: "cli-org", name: "Cli" });
    file.close();
    const r = await cli(
      ["policy", "--environment", "release", "--required", "1", "--allow-author-approval"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.err.join("\n")).toContain("approvers required 2 -> 1");
    const again = openDatabase(join(dir, "turntable.db"));
    try {
      expect(await getEnvPolicy(again, org.id, "release")).toMatchObject({
        required: 1,
        allowAuthorApproval: true,
        source: "configured",
      });
      expect((await listEnvPolicies(again, org.id)).map((p) => p.environment)).toEqual(["release"]);
      const stored = await resolveSetting(rt(), again, KEY, { orgId: org.id, orgSlug: "cli-org" });
      expect(stored).toMatchObject({ source: "db", value: { release: solo } });
      const system = await systemOrgId(again);
      for (const orgId of [system, org.id]) {
        const rows = (await listAudit(again, { orgId })).filter((x) => x.op === "setting_changed");
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.input).loosened).toHaveLength(2);
      }
      expect(
        await listEvents(
          again,
          { orgId: org.id },
          { after: 0, limit: 5, types: ["approval.policy_loosened"] },
        ),
      ).toHaveLength(1);
    } finally {
      again.close();
    }
  });

  test("`approvals policy` is refused while turntable.toml locks the policy, and says where", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-policy-"));
    const file = openDatabase(join(dir, "turntable.db"));
    const org = await createOrg(file, { slug: "cli-org", name: "Cli" });
    file.close();
    const config = join(dir, "turntable.toml");
    writeFileSync(config, `[orgs.cli-org.approval_policy.release]\nrequired = 2\n`);
    const r = await cli(["policy", "--environment", "release", "--required", "1"], dir, config);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/locked: it is set by turntable.toml/);
    const again = openDatabase(join(dir, "turntable.db"));
    try {
      expect(
        await resolveSetting(rt(), again, KEY, { orgId: org.id, orgSlug: "cli-org" }),
      ).toMatchObject({
        source: "default",
      });
    } finally {
      again.close();
    }
  });
});

describe("existing policies keep working after the upgrade", () => {
  test("a policy stored through setEnvPolicy is what the engine and the list read", async () => {
    await setEnvPolicy(db, a.orgId, {
      environment: "staging",
      required: 2,
      allowAuthorApproval: false,
      by: "cli",
      now: 1,
    });
    expect(await getEnvPolicy(db, a.orgId, "staging", rt())).toMatchObject({
      required: 2,
      gated: true,
      source: "configured",
    });
    // an environment with no entry keeps the built-in rule
    expect(await getEnvPolicy(db, a.orgId, "docs", rt())).toMatchObject({
      required: 1,
      gated: false,
      source: "default",
    });
    expect(await getEnvPolicy(db, a.orgId, "production", rt())).toMatchObject({
      required: 2,
      gated: true,
    });
  });
});
