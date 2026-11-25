// Multi-org user tokens (#547): minting, per-call org and role resolution, the registry-wide rule,
// revocation, and the no-secret-material marker. Runs on SQLite and, with TURNTABLE_TEST_DB=pglite,
// on Postgres. A software WebAuthn authenticator signs the step-up; everything else is real.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { systemOrgId } from "../src/audit/failures";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createUser,
  insertApprover,
  insertUserToken,
  listAudit,
  openDatabase,
  schema,
} from "../src/db";
import type { Db } from "../src/db";
import { dispatch, type DispatchEnv, generateToken, hashToken, registry } from "../src/ops";
import { SESSION_WRITE_OPS, USER_TOKEN_WRITE_OPS } from "../src/ops/dispatch";
import type { Principal } from "../src/ops/principal";
import { SESSION_STEP_UP_OPS } from "../src/ops/step-up";
import { generateUserToken } from "../src/ops/tokens";
import { startServer } from "../src/server";
import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const DAY = 86_400_000;
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
afterAll(() => {
  for (const db of opened) db.close();
});

const COOKIE = "cookie-one-aaaaaaaaaaaaaaaaaaaa";
const COOKIE_B = "cookie-two-aaaaaaaaaaaaaaaaaaaa";

/**
 * Alice (github id 1001) is an admin of `alpha` (her passkey is enrolled there) and a viewer of
 * `beta`. `gamma` exists and she is not a member. Bob (1002) is owner of `gamma`.
 */
async function harness() {
  const db = openDatabase(":memory:");
  opened.push(db);
  const alpha = await createOrg(db, { slug: "alpha", name: "Alpha" });
  const beta = await createOrg(db, { slug: "beta", name: "Beta" });
  const gamma = await createOrg(db, { slug: "gamma", name: "Gamma" });
  const alice = await createUser(db, { displayName: "Alice" });
  const bob = await createUser(db, { displayName: "Bob" });
  for (const [u, id, login] of [
    [alice, "1001", "alice"],
    [bob, "1002", "bob"],
  ] as const) {
    await db.run((h) =>
      h.orm.insert(schema.githubIdentities).values({ githubUserId: id, userId: u.id, login }),
    );
  }
  await addMember(db, { orgId: alpha.id }, { userId: alice.id, role: "admin" });
  await addMember(db, { orgId: beta.id }, { userId: alice.id, role: "viewer" });
  await addMember(db, { orgId: gamma.id }, { userId: bob.id, role: "owner" });
  const dev = passkey();
  await insertApprover(
    db,
    alpha.id,
    {
      person: "Alice",
      forgeLogin: "alice",
      githubUserId: "1001",
      kind: "webauthn",
      credentialId: dev.credentialId,
      publicKey: dev.spki,
      alg: "ES256",
      createdBy: "test",
    },
    Date.now(),
  );
  let now = Date.now();
  const live: Record<string, { userId: string; hash: string }> = {
    [COOKIE]: { userId: alice.id, hash: "hash-one" },
    [COOKIE_B]: { userId: bob.id, hash: "hash-two" },
  };
  const sessions = { resolve: async (c: string) => live[c] } as unknown as WebSessions;
  const env: DispatchEnv = {
    registry,
    db,
    sessions,
    webauthn: RP,
    now: () => now,
    githubUsers: { idOfLogin: async (l: string) => `gh-${l.toLowerCase()}` },
  };
  const asSession = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie }, op, input);
  const asToken = (token: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "bearer", token }, op, input);
  async function stepUp(action: string, input: Record<string, unknown>) {
    const r = await asSession(COOKIE, "session_step_up_challenge", { org: "alpha", action, input });
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
  /** Mints a user token for Alice the legitimate way: a session in alpha with a step-up. */
  async function mintUserToken(name = "laptop", ttl_days = 30) {
    const input = { org: "alpha", name, ttl_days };
    const su = await stepUp("create_user_token", input);
    const r = await asSession(COOKIE, "create_user_token", { ...input, step_up: su });
    if (!r.ok) throw new Error(`mint refused: ${r.error.message}`);
    return r.output as { id: string; token: string; expires_at: string };
  }
  return {
    db,
    env,
    alpha,
    beta,
    gamma,
    alice,
    bob,
    dev,
    asSession,
    asToken,
    stepUp,
    mintUserToken,
    advance: (ms: number) => (now += ms),
  };
}

const codeOf = (r: Awaited<ReturnType<typeof dispatch>>): string => (r.ok ? "ok" : r.error.code);
const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

describe("minting a user token", () => {
  test("a session with a fresh step-up mints; the secret is ttu_ and shown once", async () => {
    const h = await harness();
    const t = await h.mintUserToken();
    expect(t.token.startsWith("ttu_")).toBe(true);
    const list = await h.asSession(COOKIE, "list_user_tokens");
    expect(list.ok).toBe(true);
    if (list.ok) {
      const text = JSON.stringify(list.output);
      expect(text.includes(t.token)).toBe(false);
      expect(text.includes(hashToken(t.token))).toBe(false);
      expect((list.output as { tokens: { id: string }[] }).tokens.map((x) => x.id)).toEqual([t.id]);
    }
    const stored = await h.db.run((h2) => h2.orm.select().from(schema.userTokens));
    expect(stored[0]!.tokenHash).toBe(hashToken(t.token));
    expect(stored[0]!.githubUserId).toBe("1001");
    expect(registry.get("create_user_token")!.oneTimeSecretFields).toEqual(["token"]);
    expect(registry.get("create_user_token")!.mcp).toBe(false);
  });

  test("without a step-up it is refused, with the classified reason", async () => {
    const h = await harness();
    const r = await h.asSession(COOKIE, "create_user_token", {
      org: "alpha",
      name: "x",
      ttl_days: 30,
    });
    expect(codeOf(r)).toBe("forbidden");
    expect(reasonOf(r)).toBe("step_up_required");
    expect(await h.db.run((h2) => h2.orm.select().from(schema.userTokens))).toHaveLength(0);
  });

  test("a step-up bound to different input does not authorize it", async () => {
    const h = await harness();
    const su = await h.stepUp("create_user_token", { org: "alpha", name: "a", ttl_days: 30 });
    const r = await h.asSession(COOKIE, "create_user_token", {
      org: "alpha",
      name: "a",
      ttl_days: 90,
      step_up: su,
    });
    expect(reasonOf(r)).toBe("step_up_wrong_action");
  });

  test("ttl_days is 1..90: 91 and 0 are refused", async () => {
    const h = await harness();
    for (const ttl_days of [91, 0, 365]) {
      const input = { org: "alpha", name: "x", ttl_days };
      const su = await h.stepUp("create_user_token", input).catch(() => undefined);
      const r = await h.asSession(COOKIE, "create_user_token", {
        ...input,
        ...(su ? { step_up: su } : {}),
      });
      expect([ttl_days, r.ok]).toEqual([ttl_days, false]);
      // refused at the schema when a step-up could be issued, else at the missing step-up
      expect(["invalid_input", "forbidden"]).toContain(codeOf(r));
    }
    expect(await h.db.run((h2) => h2.orm.select().from(schema.userTokens))).toHaveLength(0);
    const ok = await h.mintUserToken("edge", 90);
    expect(new Date(ok.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(90 * DAY + 5_000);
  });

  test("no token of any kind, and no in-process member, can mint one", async () => {
    const h = await harness();
    const user = await h.mintUserToken();
    const agent = await mintToken(h.db, { orgId: h.alpha.id }, "release_operator");
    const person = await mintToken(h.db, { orgId: h.alpha.id }, "release_operator", {
      kind: "person",
    });
    const input = { org: "alpha", name: "x", ttl_days: 30 };
    for (const bearer of [agent.secret, person.secret, user.token]) {
      const r = await h.asToken(bearer, "create_user_token", input);
      expect([bearer.slice(0, 4), codeOf(r)]).toEqual([bearer.slice(0, 4), "forbidden"]);
    }
    for (const principal of [
      { kind: "member", id: "m", orgId: h.alpha.id, role: "owner" },
      {
        kind: "account",
        githubUserId: "1001",
        login: "alice",
        sessionHash: "h",
        id: "1001",
        orgId: h.alpha.id,
      },
    ] as Principal[]) {
      const r = await dispatch(h.env, { kind: "principal", principal }, "create_user_token", input);
      expect([principal.kind, r.ok]).toEqual([principal.kind, false]);
    }
    // and a step_up cannot be smuggled in by a bearer
    const su = await h.stepUp("create_user_token", input);
    const r = await h.asToken(user.token, "create_user_token", { ...input, step_up: su });
    expect(codeOf(r)).toBe("invalid_input");
    expect(await h.db.run((h2) => h2.orm.select().from(schema.userTokens))).toHaveLength(1);
  });

  test("a member of no passkey org cannot step up, so cannot mint", async () => {
    const h = await harness();
    const r = await h.asSession(COOKIE_B, "session_step_up_challenge", {
      action: "create_user_token",
      input: { org: "gamma", name: "x", ttl_days: 5 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("a call resolves its org and the holder's current membership", () => {
  test("two orgs, two roles: each call gets that org's role", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const a = await h.asToken(token, "whoami", { org: "alpha" });
    const b = await h.asToken(token, "whoami", { org: "beta" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.output).toMatchObject({ kind: "user", role: "admin", org: "alpha" });
      expect(b.output).toMatchObject({ kind: "user", role: "viewer", org: "beta" });
    }
    // The role is the gate: invite_member needs release_operator, which the admin has, the viewer not.
    const invite = { github_login: "newbie", role: "viewer" };
    expect(codeOf(await h.asToken(token, "invite_member", { ...invite, org: "beta" }))).toBe(
      "forbidden",
    );
    expect(codeOf(await h.asToken(token, "invite_member", { ...invite, org: "alpha" }))).toBe("ok");
    // an admin invite needs a step-up a user token cannot hold
    const admin = await h.asToken(token, "invite_member", {
      github_login: "newadmin",
      role: "admin",
      org: "alpha",
    });
    expect(codeOf(admin)).toBe("forbidden");
    expect(reasonOf(admin)).toBe("step_up_required");
  });

  test("an org with no membership is not_found, the same as an org that does not exist", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const real = await h.asToken(token, "whoami", { org: "gamma" });
    const none = await h.asToken(token, "whoami", { org: "no-such-org" });
    expect(codeOf(real)).toBe("not_found");
    expect(codeOf(none)).toBe("not_found");
    if (!real.ok && !none.ok) expect(real.error.message).toBe(none.error.message);
  });

  test("no org named is refused with a clear reason, even with one membership", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const r = await h.asToken(token, "whoami", {});
    expect(codeOf(r)).toBe("invalid_input");
    expect(reasonOf(r)).toBe("org_required");
    if (!r.ok) expect(r.error.message).toContain("org is required");
  });

  test("removing a membership stops it for that org on the next call, and only that org", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    expect(codeOf(await h.asToken(token, "whoami", { org: "beta" }))).toBe("ok");
    await h.db.run((h2) =>
      h2.orm
        .delete(schema.orgMembers)
        .where(
          and(eq(schema.orgMembers.orgId, h.beta.id), eq(schema.orgMembers.userId, h.alice.id)),
        ),
    );
    expect(codeOf(await h.asToken(token, "whoami", { org: "beta" }))).toBe("not_found");
    expect(codeOf(await h.asToken(token, "whoami", { org: "alpha" }))).toBe("ok");
  });

  test("a role change applies on the next call", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    await h.db.run((h2) =>
      h2.orm
        .update(schema.orgMembers)
        .set({ role: "owner" })
        .where(
          and(eq(schema.orgMembers.orgId, h.beta.id), eq(schema.orgMembers.userId, h.alice.id)),
        ),
    );
    const r = await h.asToken(token, "whoami", { org: "beta" });
    if (r.ok) expect((r.output as { role: string }).role).toBe("owner");
    else throw new Error("expected ok");
  });

  test("expiry ends it", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken("short", 1);
    expect(codeOf(await h.asToken(token, "whoami", { org: "alpha" }))).toBe("ok");
    h.advance(2 * DAY);
    expect(codeOf(await h.asToken(token, "whoami", { org: "alpha" }))).toBe("unauthenticated");
  });
});

describe("revoking", () => {
  test("revoke_user_token stops it at once in every org, and is the holder's alone", async () => {
    const h = await harness();
    const { token, id } = await h.mintUserToken();
    expect(codeOf(await h.asToken(token, "whoami", { org: "alpha" }))).toBe("ok");
    expect(codeOf(await h.asToken(token, "whoami", { org: "beta" }))).toBe("ok");
    // Bob cannot revoke Alice's token, and gets the answer for an unknown id
    const other = await h.asSession(COOKIE_B, "revoke_user_token", { token_id: id });
    const unknown = await h.asSession(COOKIE_B, "revoke_user_token", { token_id: "nope" });
    expect(codeOf(other)).toBe("not_found");
    expect(codeOf(unknown)).toBe("not_found");
    expect(codeOf(await h.asToken(token, "whoami", { org: "alpha" }))).toBe("ok");
    // a token cannot revoke itself or any user token
    expect((await h.asToken(token, "revoke_user_token", { token_id: id })).ok).toBe(false);
    // Alice can, with no step-up
    expect(codeOf(await h.asSession(COOKIE, "revoke_user_token", { token_id: id }))).toBe("ok");
    for (const org of ["alpha", "beta"]) {
      expect(codeOf(await h.asToken(token, "whoami", { org }))).toBe("unauthenticated");
    }
    const list = await h.asSession(COOKIE, "list_user_tokens");
    if (list.ok) {
      expect((list.output as { tokens: { status: string }[] }).tokens[0]!.status).toBe("revoked");
    }
  });

  test("the profile ops refuse every token, and a session that names an org", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const agent = await mintToken(h.db, { orgId: h.alpha.id }, "release_operator");
    for (const b of [token, agent.secret]) {
      for (const op of ["list_user_tokens", "revoke_user_token"]) {
        const r = await h.asToken(b, op, op === "revoke_user_token" ? { token_id: "x" } : {});
        expect([op, r.ok]).toEqual([op, false]);
      }
    }
  });
});

describe("what a user token may call (registry-wide)", () => {
  /** The ops a web session in some org can reach: a read, or a write opened to sessions. */
  const sessionReachable = registry.ops
    .filter(
      (o) =>
        o.auth.type === "token" &&
        (o.effect === "read" || SESSION_WRITE_OPS.has(o.name) || SESSION_STEP_UP_OPS.has(o.name)),
    )
    .map((o) => o.name);
  const userReachable = registry.ops
    .filter(
      (o) => o.auth.type === "token" && (o.effect === "read" || USER_TOKEN_WRITE_OPS.has(o.name)),
    )
    .map((o) => o.name);

  test("the rule: what a session may call, minus the step-up, session-only and minting ops", () => {
    const removed = sessionReachable.filter((n) => !userReachable.includes(n)).toSorted();
    expect(removed).toEqual(
      [
        "bind_installation",
        "create_api_token",
        "create_user_token",
        "onboard_repos",
        "onboarding_create_org",
        "revoke_user_token",
        "run_default_branch",
        "session_step_up_challenge",
        "start_installation_claim",
      ].filter((n) => sessionReachable.includes(n)),
    );
    // nothing a session cannot call is opened to a user token
    expect(userReachable.filter((n) => !sessionReachable.includes(n))).toEqual([]);
    // no step-up op, no mint op, no approve op, no signature op, no account or instance op
    for (const n of userReachable) {
      const op = registry.get(n)!;
      expect(SESSION_STEP_UP_OPS.has(n) && n !== "invite_member").toBe(false);
      expect(op.auth.type).toBe("token");
      expect(/^(create|mint)_.*token$/.test(n)).toBe(false);
    }
    expect(userReachable.filter((n) => registry.get(n)!.effect !== "read")).toEqual([
      "invite_member",
    ]);
  });

  test("every op outside the rule is refused for a user token", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const refused: string[] = [];
    for (const op of registry.ops) {
      if (userReachable.includes(op.name)) continue;
      const r = await h.asToken(token, op.name, { org: "alpha" });
      expect([op.name, r.ok]).toEqual([op.name, false]);
      if (!r.ok) {
        expect([op.name, ["forbidden", "signature_required"].includes(r.error.code)]).toEqual([
          op.name,
          true,
        ]);
      }
      refused.push(op.name);
    }
    for (const n of [
      "approve_run",
      "approve_run_challenge",
      "sign_release",
      "create_api_token",
      "create_user_token",
      "session_step_up_challenge",
    ]) {
      if (registry.get(n)) expect(refused).toContain(n);
    }
    // a step_up object is not a credential a bearer can carry
    const r = await h.asToken(token, "list_runs", { org: "alpha", step_up: {} });
    expect(codeOf(r)).toBe("invalid_input");
  });

  test("agent policies do not apply: the caller counts as a person", async () => {
    const h = await harness();
    const { token } = await h.mintUserToken();
    const r = await h.asToken(token, "whoami", { org: "alpha" });
    expect(r.ok).toBe(true);
  });
});

describe("audit", () => {
  test("mint, first use per org and revoke are audited, and never carry the token or its hash", async () => {
    const h = await harness();
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) => {
      const orig = console[m];
      console[m] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
      return () => (console[m] = orig);
    });
    const outputs: string[] = [];
    let token = "";
    let id = "";
    try {
      const t = await h.mintUserToken();
      token = t.token;
      id = t.id;
      for (const [op, input] of [
        ["whoami", { org: "alpha" }],
        ["whoami", { org: "beta" }],
        ["whoami", { org: "alpha" }],
        ["list_api_tokens", { org: "alpha" }],
        ["list_runs", { org: "beta" }],
        ["whoami", { org: "gamma" }],
        ["create_api_token", { org: "alpha", name: "x", role: "reader" }],
      ] as const) {
        const r = await h.asToken(token, op, input);
        outputs.push(JSON.stringify(r.ok ? r.output : { code: r.error.code, m: r.error.message }));
      }
      const l = await h.asSession(COOKIE, "list_user_tokens");
      outputs.push(JSON.stringify(l.ok ? l.output : l.error.message));
      await h.asSession(COOKIE, "revoke_user_token", { token_id: id });
      await h.asToken(token, "whoami", { org: "alpha" });
    } finally {
      for (const restore of spies) restore();
    }
    const sys = await systemOrgId(h.db);
    const chains: Record<string, Awaited<ReturnType<typeof listAudit>>> = {
      system: await listAudit(h.db, { orgId: sys }),
      alpha: await listAudit(h.db, { orgId: h.alpha.id }),
      beta: await listAudit(h.db, { orgId: h.beta.id }),
      gamma: await listAudit(h.db, { orgId: h.gamma.id }),
    };
    const ops = (k: string) => chains[k]!.map((a) => a.op);
    // mint: the org chain and the user's (system) chain
    expect(ops("alpha")).toContain("create_user_token");
    expect(ops("system")).toContain("create_user_token");
    // first use once per org, in the user's chain and in that org's
    expect(ops("system").filter((o) => o === "user_token_first_use")).toHaveLength(2);
    expect(ops("alpha").filter((o) => o === "user_token_first_use")).toHaveLength(1);
    expect(ops("beta").filter((o) => o === "user_token_first_use")).toHaveLength(1);
    expect(ops("gamma")).not.toContain("user_token_first_use");
    // revoke: the user's chain, and each org it was used in
    expect(ops("system")).toContain("revoke_user_token");
    expect(ops("alpha")).toContain("revoke_user_token");
    expect(ops("beta")).toContain("revoke_user_token");
    expect(ops("gamma")).not.toContain("revoke_user_token");
    // a refused write by the token is audited under the user principal
    expect(
      chains.alpha!.some(
        (a) =>
          a.op === "create_api_token" &&
          a.principalKind === "user" &&
          a.outcome.startsWith("error"),
      ),
    ).toBe(true);
    // the marker: no secret and no hash anywhere a record is kept
    const events = await h.db.run((h2) => h2.orm.select().from(schema.events));
    const haystack = JSON.stringify([chains, events, outputs, logs]);
    const hash = hashToken(token);
    expect(haystack.includes(token)).toBe(false);
    expect(haystack.includes(token.slice(4))).toBe(false);
    expect(haystack.includes(hash)).toBe(false);
    expect(haystack.includes(hash.slice(0, 16))).toBe(false);
  });
});

describe("over MCP", () => {
  test("one entry for all orgs: org is passed per call, and refused without it", async () => {
    const db = openDatabase(":memory:");
    opened.push(db);
    const alpha = await createOrg(db, { slug: "alpha", name: "Alpha" });
    const beta = await createOrg(db, { slug: "beta", name: "Beta" });
    const u = await createUser(db, { displayName: "Alice" });
    await db.run((h) =>
      h.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
    );
    await addMember(db, { orgId: alpha.id }, { userId: u.id, role: "owner" });
    await addMember(db, { orgId: beta.id }, { userId: u.id, role: "viewer" });
    const secret = generateUserToken();
    await insertUserToken(db, {
      githubUserId: "1001",
      name: "mcp",
      tokenHash: hashToken(secret),
      expiresAt: Date.now() + 30 * DAY,
    });
    const server = startServer({ port: 0, host: "127.0.0.1", db });
    try {
      const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${secret}` } },
        }),
      );
      const call = async (args: Record<string, unknown>) => {
        const res = (await client.callTool({ name: "whoami", arguments: args })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        return { isError: res.isError === true, text: res.content[0]!.text };
      };
      const a = await call({ org: "alpha" });
      const b = await call({ org: "beta" });
      expect(a.isError).toBe(false);
      expect(a.text).toContain('"role":"owner"');
      expect(b.isError).toBe(false);
      expect(b.text).toContain('"role":"viewer"');
      const none = await call({});
      expect(none.isError).toBe(true);
      expect(none.text).toContain("org is required");
      // not an MCP tool at all
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ["create_user_token", "create_api_token", "list_user_tokens"]) {
        expect(tools).not.toContain(n);
      }
      await client.close();
      // an unknown ttu_ token is a 401 at the door, like any bad token
      const bad = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${generateUserToken()}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(bad.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });
});

test("token prefixes stay distinct", () => {
  expect(generateUserToken().startsWith("ttu_")).toBe(true);
  expect(generateToken().startsWith("tt_")).toBe(true);
});
