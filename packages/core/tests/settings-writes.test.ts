// Settings writes by the instance administrator (#571) and by owner sessions (#578), with the
// trust marker: a `trust: "tighten_only"` setting may be tightened by the instance administrator
// but loosened only by the org's owner, from a session with a fresh passkey step-up. A software
// WebAuthn authenticator signs the step-up. Runs on SQLite and, with TURNTABLE_TEST_DB, pglite.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import type { WebSessions } from "../src/auth/web-sessions";
import { systemOrgId } from "../src/audit/failures";
import {
  addMember,
  createOrg,
  createProject,
  createUser,
  insertApprover,
  listAudit,
  openDatabase,
  schema,
} from "../src/db";
import type { Db } from "../src/db";
import { putStoredSetting } from "../src/db/repos/settings";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { loadSettingsRuntime } from "../src/settings/boot";
import { loosens } from "../src/settings/define";
import { settingsRegistry, untrustedRunApprovalSetting } from "../src/settings/definitions";
import { resolveSetting, storeTarget } from "../src/settings/resolve";

import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const KEY = "untrusted_run_approval";

function passkey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  let counter = 0;
  return {
    credentialId: credentialId.toString("base64url"),
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    assert(challenge: string) {
      counter += 1;
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: RP.origins[0] }),
      );
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(RP.rpId), Buffer.from([0x05]), c]);
      const sig = createSign("sha256")
        .update(Buffer.concat([authData, sha256(clientData)]))
        .sign(privateKey as KeyObject);
      return {
        credential_id: credentialId.toString("base64url"),
        client_data_json: clientData.toString("base64url"),
        authenticator_data: authData.toString("base64url"),
        signature: sig.toString("base64url"),
      };
    },
  };
}

const opened: Db[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

const rt = (toml?: string) =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env: {},
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });

const ROLES = ["owner", "admin", "member", "viewer"] as const;

async function harness(settings = rt()) {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "tenant", name: "Tenant" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
  const dev = passkey();
  const live: Record<string, { userId: string; hash: string }> = {};
  let n = 0;
  for (const role of ROLES) {
    n += 1;
    const user = await createUser(db, { displayName: role });
    await db.run((h) =>
      h.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: `100${n}`, userId: user.id, login: role }),
    );
    await addMember(db, { orgId: org.id }, { userId: user.id, role });
    live[`cookie-${role}-aaaaaaaaaaaaaaaaaaaa`] = { userId: user.id, hash: `hash-${role}` };
    if (role === "owner") {
      await insertApprover(
        db,
        org.id,
        {
          person: "owner",
          forgeLogin: "owner",
          githubUserId: `100${n}`,
          kind: "webauthn",
          credentialId: dev.credentialId,
          publicKey: dev.spki,
          alg: "ES256",
          createdBy: "test",
        },
        Date.now(),
      );
    }
  }
  const sessions = { resolve: async (c: string) => live[c] } as unknown as WebSessions;
  const env = {
    registry,
    db,
    sessions,
    webauthn: RP,
    settings,
    allowInstance: true,
  } as DispatchEnv;
  const instance = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const cookie = (role: (typeof ROLES)[number]) => `cookie-${role}-aaaaaaaaaaaaaaaaaaaa`;
  const as = (role: (typeof ROLES)[number], op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie: cookie(role) }, op, { org: "tenant", ...input });
  const asInstance = (op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "bearer", token: instance }, op, input);
  async function stepUp(input: Record<string, unknown>) {
    const r = await as("owner", "session_step_up_challenge", {
      action: "set_setting",
      input: { org: "tenant", ...input },
    });
    if (!r.ok) throw new Error(`challenge refused: ${r.error.message}`);
    const out = r.output as {
      step_up_id: string;
      challenge: string;
      passkeys: { approver: string }[];
    };
    return {
      id: out.step_up_id,
      approver: out.passkeys[0]!.approver,
      signature: dev.assert(out.challenge),
    };
  }
  const subject = { orgId: org.id, projectId: project.id };
  const seed = (value: string) =>
    putStoredSetting(
      db,
      storeTarget(untrustedRunApprovalSetting, subject),
      KEY,
      value,
      "seed",
      Date.now(),
    );
  const effective = async (key = KEY) => (await resolveSetting(settings, db, key, subject)).value;
  return { db, org, project, as, asInstance, stepUp, seed, effective };
}

const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

describe("trust marker", () => {
  test("untrusted_run_approval and run_dispatch_agents are tighten-only, strictest last in the list", () => {
    for (const k of ["untrusted_run_approval", "run_dispatch_agents"]) {
      expect(settingsRegistry.get(k)!.trust).toBe("tighten_only");
    }
    const d = settingsRegistry.get(KEY)!;
    expect(loosens(d, "human", "no_agents")).toBe(true);
    expect(loosens(d, "no_agents", "any")).toBe(true);
    expect(loosens(d, "any", "human")).toBe(false);
    expect(loosens(d, "no_agents", "no_agents")).toBe(false);
    const rd = settingsRegistry.get("run_dispatch_agents")!;
    expect(loosens(rd, "none", "unprivileged")).toBe(true);
    expect(loosens(rd, "any", "none")).toBe(false);
    // an ordinary setting never loosens
    expect(loosens(settingsRegistry.get("checks_mode")!, "live", "off")).toBe(false);
  });
});

describe("instance administrator (#571)", () => {
  test("sets checks_mode on a project, audited in the system chain and the org's", async () => {
    const h = await harness();
    const r = await h.asInstance("instance_set_setting", {
      key: "checks_mode",
      value: "shadow",
      target_org: "tenant",
      target_project: "web",
    });
    expect(r.ok).toBe(true);
    expect(await h.effective("checks_mode")).toBe("shadow");
    const sys = await systemOrgId(h.db);
    for (const orgId of [sys, h.org.id]) {
      const row = (await listAudit(h.db, { orgId }, { limit: 20 })).find(
        (x) => x.op === "setting_changed",
      );
      expect(JSON.parse(row!.input), String(orgId)).toMatchObject({
        key: "checks_mode",
        from: "off",
        to: "shadow",
      });
    }
    // reads accept the same targeting
    const got = await h.asInstance("instance_get_setting", {
      key: "checks_mode",
      target_org: "tenant",
      target_project: "web",
    });
    expect(got.ok && (got.output as { value: unknown }).value).toBe("shadow");
    const list = await h.asInstance("instance_list_settings", {
      target_org: "tenant",
      target_project: "web",
    });
    const keys = list.ok
      ? (list.output as { settings: { key: string }[] }).settings.map((s) => s.key)
      : [];
    expect(keys).toContain("checks_mode");
    expect(keys).toContain("backup_keep");
    const noTarget = await h.asInstance("instance_get_setting", { key: "checks_mode" });
    expect(noTarget.ok).toBe(false);
  });

  test("tightens untrusted_run_approval; loosening is refused with the reason", async () => {
    const h = await harness();
    await h.seed("any");
    const input = { key: KEY, target_org: "tenant", target_project: "web" };
    expect((await h.asInstance("instance_set_setting", { ...input, value: "no_agents" })).ok).toBe(
      true,
    );
    const loose = await h.asInstance("instance_set_setting", { ...input, value: "any" });
    expect(!loose.ok && loose.error.code).toBe("forbidden");
    expect(!loose.ok && loose.error.message).toBe(`only the org's owner can loosen ${KEY}`);
    expect(reasonOf(loose)).toBe("trust_loosening_needs_owner");
    expect(await h.effective()).toBe("no_agents");
    // unset goes to the default (no_agents here): equal, not a loosening; from human it would be
    await h.seed("human");
    const unset = await h.asInstance("instance_set_setting", { ...input, unset: true });
    expect(reasonOf(unset)).toBe("trust_loosening_needs_owner");
  });

  test("a locked setting is refused", async () => {
    const h = await harness(rt('[orgs.tenant.projects.web]\nchecks_mode = "live"\n'));
    const r = await h.asInstance("instance_set_setting", {
      key: "checks_mode",
      value: "off",
      target_org: "tenant",
      target_project: "web",
    });
    expect(!r.ok && r.error.message).toMatch(/locked/);
  });

  test("a tenant token is refused the instance ops", async () => {
    const h = await harness();
    const { secret } = await mintToken(
      h.db,
      { orgId: h.org.id, projectId: h.project.id },
      "release_operator",
      { kind: "person" },
    );
    for (const op of ["instance_set_setting", "instance_get_setting"]) {
      const r = await dispatch(
        { registry, db: h.db, allowInstance: true } as DispatchEnv,
        { kind: "bearer", token: secret },
        op,
        { key: "checks_mode", value: "live", target_org: "tenant", target_project: "web" },
      );
      expect(!r.ok && r.error.code, op).toBe("forbidden");
    }
  });
});

describe("owner and admin sessions (#578)", () => {
  const set = (value: unknown, extra: Record<string, unknown> = {}) => ({
    key: "checks_mode",
    value,
    project: "web",
    ...extra,
  });

  test("an owner session sets checks_mode with no step-up; so does an admin", async () => {
    const h = await harness();
    expect((await h.as("owner", "set_setting", set("shadow"))).ok).toBe(true);
    expect(await h.effective("checks_mode")).toBe("shadow");
    expect((await h.as("admin", "set_setting", set("live"))).ok).toBe(true);
    expect(await h.effective("checks_mode")).toBe("live");
  });

  test("a member or viewer session is refused by role", async () => {
    const h = await harness();
    for (const role of ["member", "viewer"] as const) {
      const r = await h.as(role, "set_setting", set("live"));
      expect(r.ok, role).toBe(false);
      expect(!r.ok && r.error.code, role).toBe("forbidden");
    }
    expect(await h.effective("checks_mode")).toBe("off");
  });

  test("loosening a trust setting needs a step-up bound to the input; tightening does not", async () => {
    const h = await harness();
    await h.seed("human");
    const input = { key: KEY, value: "no_agents", project: "web" };
    const without = await h.as("owner", "set_setting", input);
    expect(!without.ok && without.error.code).toBe("forbidden");
    expect(reasonOf(without)).toBe("step_up_required");
    expect(await h.effective()).toBe("human");
    const su = await h.stepUp(input);
    // a step-up for other parameters does not carry over
    const other = await h.as("owner", "set_setting", { ...input, value: "any", step_up: su });
    expect(reasonOf(other)).toBe("step_up_wrong_action");
    const su2 = await h.stepUp(input);
    const ok = await h.as("owner", "set_setting", { ...input, step_up: su2 });
    expect(ok.ok).toBe(true);
    expect(await h.effective()).toBe("no_agents");
    // tightening back needs none (any person with the role; the approver exists for human)
    await h.seed("any");
    const tight = await h.as("owner", "set_setting", {
      key: KEY,
      value: "no_agents",
      project: "web",
    });
    expect(tight.ok).toBe(true);
    // a step-up is spent once
    const reuse = await h.as("owner", "set_setting", {
      ...input,
      value: "no_agents",
      step_up: su2,
    });
    expect(reuse.ok).toBe(false);
  });

  test("an admin below the setting's owner role is refused even with the trust rules", async () => {
    const h = await harness();
    await h.seed("human");
    const r = await h.as("admin", "set_setting", { key: KEY, value: "no_agents", project: "web" });
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(await h.effective()).toBe("human");
  });
});

describe("pr_code_scanning_upload (#705)", () => {
  const CS = "pr_code_scanning_upload";
  const on = { key: CS, value: true, project: "web" };

  test("enabling it is a loosening: step-up for a session, never an org token or MCP, audited", async () => {
    const h = await harness();
    const def = settingsRegistry.get(CS)!;
    expect(def.trust).toBe("tighten_only");
    expect(def.mcpEditable).toBe(false);
    expect(loosens(def, false, true)).toBe(true);
    expect(loosens(def, true, false)).toBe(false);
    expect(await h.effective(CS)).toBe(false);
    const without = await h.as("owner", "set_setting", on);
    expect(reasonOf(without)).toBe("step_up_required");
    expect(await h.effective(CS)).toBe(false);
    const ok = await h.as("owner", "set_setting", { ...on, step_up: await h.stepUp(on) });
    expect(ok.ok).toBe(true);
    expect(await h.effective(CS)).toBe(true);
    const row = (await listAudit(h.db, { orgId: h.org.id }, { limit: 20 })).find(
      (x) => x.op === "setting_changed",
    );
    expect(JSON.stringify(row)).toContain("security_events");
    // switching it off needs no step-up
    const off = await h.as("owner", "set_setting", { ...on, value: false });
    expect(off.ok).toBe(true);
    expect(await h.effective(CS)).toBe(false);
  });

  test("a member is refused by role", async () => {
    const h = await harness();
    const r = await h.as("member", "set_setting", on);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(await h.effective(CS)).toBe(false);
  });
});
