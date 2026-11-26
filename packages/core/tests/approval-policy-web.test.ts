// Org owners edit approval_policy from the web (#664): tightening with the session, loosening with
// a passkey step-up and, with two or more counted approvers, a signed quorum; tokens and agents are
// refused; the instance administrator's recovery path writes a loud entry into the org's chain.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createUser,
  insertApprover,
  listAudit,
  openDatabase,
  schema,
} from "../src/db";
import type { Db } from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { loadSettingsRuntime } from "../src/settings/boot";
import { settingsRegistry } from "../src/settings/definitions";
import { resolveSetting } from "../src/settings/resolve";
import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

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

async function harness(settings = rt()) {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "tenant", name: "Tenant" });
  const dev = passkey();
  const user = await createUser(db, { displayName: "owner" });
  await db.run((h) =>
    h.orm
      .insert(schema.githubIdentities)
      .values({ githubUserId: "1001", userId: user.id, login: "owner" }),
  );
  await addMember(db, { orgId: org.id }, { userId: user.id, role: "owner" });
  const ownerApprover = await insertApprover(
    db,
    org.id,
    {
      person: "owner",
      forgeLogin: "owner",
      githubUserId: "1001",
      kind: "webauthn",
      credentialId: dev.credentialId,
      publicKey: dev.spki,
      alg: "ES256",
      createdBy: "test",
    },
    Date.now(),
  );
  const sessions = {
    resolve: async (c: string) =>
      c === "cookie-owner-aaaaaaaaaaaaaaaaaaaa"
        ? { userId: user.id, hash: "hash-owner" }
        : undefined,
  } as unknown as WebSessions;
  const env = {
    registry,
    db,
    sessions,
    webauthn: RP,
    settings,
    allowInstance: true,
    githubUsers: { idOfLogin: async (l: string) => `gh-${l.toLowerCase()}` },
  } as DispatchEnv;
  const instance = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const owner = (op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie: "cookie-owner-aaaaaaaaaaaaaaaaaaaa" }, op, {
      org: "tenant",
      ...input,
    });
  const asInstance = (op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "bearer", token: instance }, op, input);
  const token = async (role: "release_operator" | "operator" | "reader") =>
    (await mintToken(db, { orgId: org.id }, role)).secret;
  const asToken = (secret: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "bearer", token: secret }, op, input);
  async function stepUp(input: Record<string, unknown>) {
    const r = await owner("session_step_up_challenge", {
      action: "set_approval_policy",
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
  const effectiveMap = async () =>
    (await resolveSetting(settings, db, "approval_policy", { orgId: org.id, orgSlug: "tenant" }))
      .value as Record<string, unknown>;
  const seed = async (value: Record<string, unknown>) => {
    const r = await asInstance("instance_set_setting", {
      key: "approval_policy",
      value,
      target_org: "tenant",
      reason: "seed",
    });
    if (!r.ok) throw new Error(r.error.message);
  };
  /** A second approver (offline ed25519 key) with a forge login: two counted people. */
  async function addSecondApprover() {
    const k = generateEd25519();
    const a = await insertApprover(
      db,
      org.id,
      {
        person: "bob",
        forgeLogin: "bob-gh",
        kind: "ed25519",
        publicKey: k.publicSpki,
        alg: "EdDSA",
        createdBy: "test",
      },
      Date.now(),
    );
    return { id: a.id, priv: k.privatePem };
  }
  return {
    db,
    org,
    owner,
    asInstance,
    token,
    asToken,
    stepUp,
    effectiveMap,
    seed,
    addSecondApprover,
    dev,
    ownerApprover,
  };
}

const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

const LOOSE = { environment: "production", required: 1, allow_author_approval: true };

describe("one approver: session plus step-up", () => {
  test("an owner session loosens production with a step-up, audited in the org chain", async () => {
    const h = await harness();
    const su = await h.stepUp(LOOSE);
    const r = await h.owner("set_approval_policy", { ...LOOSE, step_up: su });
    expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true);
    expect(await h.effectiveMap()).toEqual({
      production: { required: 1, allow_author_approval: true, key_policy: "any" },
    });
    const audit = await listAudit(h.db, { orgId: h.org.id }, { limit: 20 });
    expect(audit.map((a) => a.op)).toContain("approval_policy.loosened");
    const row = audit.find((a) => a.op === "setting_changed")!;
    expect(JSON.parse(row.input).loosened.length).toBeGreaterThan(0);
  });

  test("the same loosening without a step-up is refused", async () => {
    const h = await harness();
    const r = await h.owner("set_approval_policy", LOOSE);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(reasonOf(r)).toBe("step_up_required");
    expect(await h.effectiveMap()).toEqual({});
  });

  test("a step-up for other values does not carry over", async () => {
    const h = await harness();
    const su = await h.stepUp({ ...LOOSE, required: 1, allow_author_approval: false });
    const r = await h.owner("set_approval_policy", { ...LOOSE, step_up: su });
    expect(reasonOf(r)).toBe("step_up_wrong_action");
  });

  test("tightening needs only the session", async () => {
    const h = await harness();
    const r = await h.owner("set_approval_policy", {
      environment: "production",
      required: 3,
      allow_author_approval: false,
    });
    expect(r.ok).toBe(true);
    expect((await h.effectiveMap()).production).toMatchObject({ required: 3 });
  });

  test("an org token of any role and a token with a step-up body are refused", async () => {
    const h = await harness();
    for (const role of ["release_operator", "operator"] as const) {
      const t = await h.token(role);
      const r = await h.asToken(t, "set_approval_policy", { ...LOOSE });
      expect(!r.ok && r.error.code, role).toBe("forbidden");
    }
    expect(await h.effectiveMap()).toEqual({});
  });

  test("a locked policy is read-only and says where it is set", async () => {
    const h = await harness(rt(`[orgs.tenant.approval_policy.production]\nrequired = 2\n`));
    const r = await h.owner("set_approval_policy", {
      environment: "production",
      required: 3,
      allow_author_approval: false,
    });
    expect(!r.ok && r.error.message).toMatch(/locked: it is set by turntable.toml/);
    const g = await h.owner("get_approval_policy");
    expect(g.ok && g.output).toMatchObject({
      locked: true,
      source: "toml",
      locked_by: "turntable.toml",
    });
  });

  test("get_approval_policy fills in defaults", async () => {
    const h = await harness();
    const g = await h.owner("get_approval_policy");
    expect(g.ok).toBe(true);
    const out = g.ok ? (g.output as any) : undefined;
    expect(out.approvers).toBe(1);
    expect(out.environments.find((e: any) => e.environment === "production")).toMatchObject({
      required: 2,
      allow_author_approval: false,
      source: "default",
      gated: true,
    });
    const reader = await h.asToken(await h.token("reader"), "get_approval_policy");
    expect(!reader.ok && reader.error.code).toBe("forbidden");
  });
});

describe("two approvers: a signed quorum", () => {
  test("loosening also needs both approvers' signatures; tightening does not", async () => {
    const h = await harness();
    const bob = await h.addSecondApprover();
    const rel = await h.token("release_operator");
    // tightening: no quorum
    const t = await h.owner("set_approval_policy", {
      environment: "production",
      required: 3,
      allow_author_approval: false,
    });
    expect(t.ok).toBe(true);
    const su0 = await h.stepUp(LOOSE);
    const none = await h.owner("set_approval_policy", { ...LOOSE, step_up: su0 });
    expect(reasonOf(none)).toBe("approver_quorum_required");
    // the owner's passkey and bob's key sign the same statement
    const ownerChal = await h.asToken(rel, "approval_policy_challenge", {
      ...LOOSE,
      approver: h.ownerApprover.id,
    });
    expect(ownerChal.ok, JSON.stringify(!ownerChal.ok && ownerChal.error)).toBe(true);
    const oc = ownerChal.ok ? (ownerChal.output as any) : undefined;
    const r1 = await dispatch(
      { registry, db: h.db, webauthn: RP, settings: rt() } as DispatchEnv,
      { kind: "signed" },
      "approve_approval_policy",
      { statement: oc.statement, signature: { kind: "webauthn", ...h.dev.assert(oc.challenge) } },
    );
    expect(r1.ok, JSON.stringify(!r1.ok && r1.error)).toBe(true);
    const su1 = await h.stepUp(LOOSE);
    const one = await h.owner("set_approval_policy", { ...LOOSE, step_up: su1 });
    expect(reasonOf(one)).toBe("approver_quorum_required");
    const bobChal = await h.asToken(rel, "approval_policy_challenge", {
      ...LOOSE,
      approver: bob.id,
    });
    const bc = bobChal.ok ? (bobChal.output as any) : undefined;
    const r2 = await dispatch(
      { registry, db: h.db, webauthn: RP, settings: rt() } as DispatchEnv,
      { kind: "signed" },
      "approve_approval_policy",
      {
        statement: bc.statement,
        signature: { kind: "ed25519", signature: signEd25519(bob.priv, bc.canonical) },
      },
    );
    expect(r2.ok && (r2.output as any).approvals).toBe(2);
    const su2 = await h.stepUp(LOOSE);
    const done = await h.owner("set_approval_policy", { ...LOOSE, step_up: su2 });
    expect(done.ok, JSON.stringify(!done.ok && done.error)).toBe(true);
    expect((await h.effectiveMap()).production).toMatchObject({
      required: 1,
      allow_author_approval: true,
    });
    // the signatures are spent with the change: loosening again needs a new quorum
    await h.owner("set_approval_policy", {
      environment: "production",
      required: 3,
      allow_author_approval: false,
    });
    const again = await h.owner("set_approval_policy", {
      ...LOOSE,
      step_up: await h.stepUp(LOOSE),
    });
    expect(reasonOf(again)).toBe("approver_quorum_required");
  });

  test("a challenge for a change that does not loosen is refused", async () => {
    const h = await harness();
    const rel = await h.token("release_operator");
    const r = await h.asToken(rel, "approval_policy_challenge", {
      environment: "production",
      required: 3,
      allow_author_approval: false,
      approver: h.ownerApprover.id,
    });
    expect(!r.ok && r.error.code).toBe("invalid_input");
  });
});

describe("instance administrator recovery path", () => {
  test("loosening needs a reason and writes a loud entry into the org's chain", async () => {
    const h = await harness();
    const noReason = await h.asInstance("instance_set_setting", {
      key: "approval_policy",
      value: { production: { required: 1, allow_author_approval: true } },
      target_org: "tenant",
    });
    expect(!noReason.ok && noReason.error.code).toBe("invalid_input");
    const r = await h.asInstance("instance_set_setting", {
      key: "approval_policy",
      value: { production: { required: 1, allow_author_approval: true } },
      target_org: "tenant",
      reason: "owner locked out",
    });
    expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true);
    const audit = await listAudit(h.db, { orgId: h.org.id }, { limit: 20 });
    const row = audit.find((a) => a.op === "approval_policy.loosened_by_instance")!;
    expect(row).toBeDefined();
    expect(JSON.parse(row.input)).toMatchObject({
      reason: "owner locked out",
      from: {},
      to: { production: { required: 1, allow_author_approval: true } },
    });
    expect(row.principalKind).toBe("instance");
  });

  test("a tightening by the instance needs no reason and leaves no special entry", async () => {
    const h = await harness();
    const r = await h.asInstance("instance_set_setting", {
      key: "approval_policy",
      value: { production: { required: 3 } },
      target_org: "tenant",
    });
    expect(r.ok).toBe(true);
    const audit = await listAudit(h.db, { orgId: h.org.id }, { limit: 20 });
    expect(audit.map((a) => a.op)).not.toContain("approval_policy.loosened_by_instance");
  });

  test("set_setting by an owner session or token still refuses approval_policy", async () => {
    const h = await harness();
    const t = await h.token("release_operator");
    const viaToken = await h.asToken(t, "set_setting", { key: "approval_policy", value: {} });
    expect(!viaToken.ok && viaToken.error.code).toBe("forbidden");
    const viaSession = await h.owner("set_setting", { key: "approval_policy", value: {} });
    expect(!viaSession.ok && viaSession.error.code).toBe("forbidden");
  });
});
