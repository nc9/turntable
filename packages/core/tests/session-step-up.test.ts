// Passkey step-up for web sessions (#430, slice 2). A software WebAuthn authenticator signs the
// step-up challenge; everything else (rows, dispatch, binding, expiry, single use) is real.
// Clocks are relative to the real time: tokens are minted with expiries counted from it.
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createProject,
  createRun,
  createUser,
  getProjectBySlug,
  listRuns,
  insertApprover,
  listAudit,
  openDatabase,
  schema,
} from "../src/db";
import type { Db } from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { SESSION_STEP_UP_OPS } from "../src/ops/step-up";
import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const MIN = 60_000;
const DAY = 86_400_000;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A software passkey: ES256, user-verified, with a counter that advances. */
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

async function harness(o: { keyId?: string | null; login?: string } = {}) {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "tenant", name: "Tenant" });
  const user = await createUser(db, { displayName: "Alice" });
  await db.run((h) =>
    h.orm
      .insert(schema.githubIdentities)
      .values({ githubUserId: "1001", userId: user.id, login: o.login ?? "Alice" }),
  );
  await addMember(db, { orgId: org.id }, { userId: user.id, role: "owner" });
  const dev = passkey();
  await insertApprover(
    db,
    org.id,
    {
      person: "Alice",
      forgeLogin: "alice",
      githubUserId: o.keyId === undefined ? "1001" : o.keyId,
      kind: "webauthn",
      credentialId: dev.credentialId,
      publicKey: dev.spki,
      alg: "ES256",
      createdBy: "test",
    },
    Date.now(),
  );
  let now = Date.now();
  // Two browser sessions of the same person: a step-up is bound to the one that asked.
  const live: Record<string, { userId: string; hash: string }> = {
    "cookie-one-aaaaaaaaaaaaaaaaaaaa": { userId: user.id, hash: "hash-one" },
    "cookie-two-aaaaaaaaaaaaaaaaaaaa": { userId: user.id, hash: "hash-two" },
  };
  const sessions = { resolve: async (c: string) => live[c] } as unknown as WebSessions;
  const lookup = { fail: false };
  const env: DispatchEnv = {
    registry,
    db,
    sessions,
    webauthn: RP,
    now: () => now,
    githubUsers: {
      idOfLogin: async (l: string) => {
        if (lookup.fail) throw new Error("GitHub is down");
        return `gh-${l.toLowerCase()}`;
      },
    },
  };
  const ONE = "cookie-one-aaaaaaaaaaaaaaaaaaaa";
  const TWO = "cookie-two-aaaaaaaaaaaaaaaaaaaa";
  const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie }, op, input);
  /** Challenge for `action` with `input`, signed by `device`; returns the `step_up` to attach. */
  async function stepUp(
    action: string,
    input: Record<string, unknown>,
    o: { cookie?: string; device?: ReturnType<typeof passkey> } = {},
  ) {
    const r = await as(o.cookie ?? ONE, "session_step_up_challenge", { action, input });
    if (!r.ok) throw new Error(`challenge refused: ${r.error.message}`);
    const out = r.output as {
      step_up_id: string;
      challenge: string;
      passkeys: { approver: string }[];
    };
    return {
      id: out.step_up_id,
      approver: out.passkeys[0]!.approver,
      signature: (o.device ?? dev).assert(out.challenge),
    };
  }
  return {
    db,
    org,
    user,
    dev,
    lookup,
    env,
    as,
    stepUp,
    ONE,
    TWO,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

const mint = { name: "ci", role: "release_operator", kind: "person", expires_in_days: 90 };
const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

describe("session passkey step-up", () => {
  test("the gated ops are exactly the ones the registry knows", () => {
    for (const n of SESSION_STEP_UP_OPS) expect(registry.get(n)).toBeDefined();
  });

  test("without a step-up a session is refused both ops, with a classified reason", async () => {
    const h = await harness();
    const a = await h.as(h.ONE, "create_api_token", mint);
    expect(a.ok).toBe(false);
    expect(reasonOf(a)).toBe("step_up_required");
    for (const role of ["admin", "owner"]) {
      const r = await h.as(h.ONE, "invite_member", { github_login: `new-${role}`, role });
      expect(r.ok, role).toBe(false);
      expect(reasonOf(r), role).toBe("step_up_required");
    }
    // a viewer or member invite still needs none
    expect((await h.as(h.ONE, "invite_member", { github_login: "v", role: "viewer" })).ok).toBe(
      true,
    );
  });

  test("a fresh step-up for exactly that request mints a token, once", async () => {
    const h = await harness();
    const su = await h.stepUp("create_api_token", mint);
    const ok = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const out = ok.output as { token: string; role: string; expires_at: string };
      expect(out.token.startsWith("tt_")).toBe(true);
      expect(out.role).toBe("release_operator");
    }
    // spent: the same step-up again is a reuse
    const again = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su });
    expect(again.ok).toBe(false);
    expect(reasonOf(again)).toBe("step_up_reused");
    // the use is audited under the session principal
    const rows = await listAudit(h.db, { orgId: h.org.id });
    expect(
      rows.some(
        (a) => a.op === "create_api_token" && a.principalKind === "session" && a.outcome === "ok",
      ),
    ).toBe(true);
  });

  test("a step-up for one input is refused for another input of the same op", async () => {
    const h = await harness();
    const su = await h.stepUp("create_api_token", { ...mint, role: "reader" });
    const wrong = await h.as(h.ONE, "create_api_token", {
      ...mint,
      role: "release_operator",
      step_up: su,
    });
    expect(wrong.ok).toBe(false);
    expect(reasonOf(wrong)).toBe("step_up_wrong_action");
    // not spent by the refusal: the request it was issued for still works
    const right = await h.as(h.ONE, "create_api_token", { ...mint, role: "reader", step_up: su });
    expect(right.ok).toBe(true);
    // a different lifetime or kind is a different request too
    const su2 = await h.stepUp("create_api_token", mint);
    const longer = await h.as(h.ONE, "create_api_token", {
      ...mint,
      expires_in_days: 91,
      step_up: su2,
    });
    expect(reasonOf(longer)).toBe("step_up_wrong_action");
  });

  test("a step-up for action A does not authorize action B", async () => {
    const h = await harness();
    const su = await h.stepUp("create_api_token", mint);
    const invite = await h.as(h.ONE, "invite_member", {
      github_login: "mallory",
      role: "admin",
      step_up: su,
    });
    expect(invite.ok).toBe(false);
    expect(reasonOf(invite)).toBe("step_up_wrong_action");
    // and an invite step-up does not mint a token
    const su2 = await h.stepUp("invite_member", { github_login: "bob", role: "admin" });
    const tok = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su2 });
    expect(reasonOf(tok)).toBe("step_up_wrong_action");
    // an op that takes no step-up refuses one
    const other = await h.as(h.ONE, "list_runs", { step_up: su2 });
    expect(other.ok).toBe(false);
  });

  test("a step-up is bound to the session that asked, and to the exact invite", async () => {
    const h = await harness();
    const su = await h.stepUp("invite_member", { github_login: "bob", role: "admin" });
    const other = await h.as(h.TWO, "invite_member", {
      github_login: "bob",
      role: "admin",
      step_up: su,
    });
    expect(reasonOf(other)).toBe("step_up_wrong_action");
    const owner = await h.as(h.ONE, "invite_member", {
      github_login: "bob",
      role: "owner",
      step_up: su,
    });
    expect(reasonOf(owner)).toBe("step_up_wrong_action");
    const ok = await h.as(h.ONE, "invite_member", {
      github_login: "bob",
      role: "admin",
      step_up: su,
    });
    expect(ok.ok).toBe(true);
  });

  test("a step-up expires after 5 minutes", async () => {
    const h = await harness();
    const su = await h.stepUp("create_api_token", mint);
    h.advance(5 * MIN + 1000);
    const r = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_expired");
    // just inside the window works
    const fresh = await h.stepUp("create_api_token", mint);
    h.advance(4 * MIN + 59_000);
    expect((await h.as(h.ONE, "create_api_token", { ...mint, step_up: fresh })).ok).toBe(true);
  });

  test("an assertion from another passkey, or a made-up id, is refused", async () => {
    const h = await harness();
    const stranger = passkey();
    const su = await h.stepUp("create_api_token", mint, { device: stranger });
    const r = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_bad_key");
    const fake = { ...su, id: randomBytes(24).toString("base64url") };
    expect(reasonOf(await h.as(h.ONE, "create_api_token", { ...mint, step_up: fake }))).toBe(
      "step_up_unknown",
    );
    // right key id, but the signature is over another challenge
    const real = await h.stepUp("create_api_token", mint);
    const forged = { ...real, signature: h.dev.assert(Buffer.alloc(32).toString("base64url")) };
    expect(reasonOf(await h.as(h.ONE, "create_api_token", { ...mint, step_up: forged }))).toBe(
      "step_up_bad_assertion",
    );
  });

  test("no enrolled passkey, no challenge", async () => {
    const h = await harness();
    const other = await createUser(h.db, { displayName: "Bob" });
    await h.db.run((x) =>
      x.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: "2002", userId: other.id, login: "bob" }),
    );
    await addMember(h.db, { orgId: h.org.id }, { userId: other.id, role: "admin" });
    const sessions = h.env.sessions as unknown as { resolve: (c: string) => Promise<unknown> };
    const prev = sessions.resolve;
    sessions.resolve = async (c) =>
      c === "cookie-bob-aaaaaaaaaaaaaaaaaaaaa" ? { userId: other.id, hash: "hash-bob" } : prev(c);
    const r = await h.as("cookie-bob-aaaaaaaaaaaaaaaaaaaaa", "session_step_up_challenge", {
      action: "create_api_token",
      input: mint,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    // and Bob cannot borrow Alice's passkey for his own challenge: there is none to ask for
  });

  test("the minted token is not capped by a dying lineage, and role and lifetime caps hold (#455)", async () => {
    const h = await harness();
    // the org's only root dies in 2 days
    await mintToken(h.db, { orgId: h.org.id }, "release_operator", {
      expiresAt: h.now() + 2 * DAY,
    });
    const su = await h.stepUp("create_api_token", mint);
    const r = await h.as(h.ONE, "create_api_token", { ...mint, step_up: su });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const exp = Date.parse((r.output as { expires_at: string }).expires_at);
      expect(exp).toBe(h.now() + 90 * DAY);
    }
    // 365 days is the maximum; 400 is refused, at the challenge and at the call
    const max = { ...mint, expires_in_days: 365 };
    expect(
      (
        await h.as(h.ONE, "create_api_token", {
          ...max,
          step_up: await h.stepUp("create_api_token", max),
        })
      ).ok,
    ).toBe(true);
    const long = { ...mint, expires_in_days: 400 };
    const c = await h.as(h.ONE, "session_step_up_challenge", {
      action: "create_api_token",
      input: long,
    });
    expect(c.ok).toBe(false);
    const su2 = await h.stepUp("create_api_token", max);
    const call = await h.as(h.ONE, "create_api_token", { ...long, step_up: su2 });
    expect(call.ok).toBe(false);
    // an agent token tops out at operator, even for an owner with a valid step-up
    const agent = { ...mint, kind: "agent" };
    const su3 = await h.stepUp("create_api_token", agent);
    const bad = await h.as(h.ONE, "create_api_token", { ...agent, step_up: su3 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("forbidden");
    const agentOk = { ...agent, role: "operator" };
    expect(
      (
        await h.as(h.ONE, "create_api_token", {
          ...agentOk,
          step_up: await h.stepUp("create_api_token", agentOk),
        })
      ).ok,
    ).toBe(true);
  });

  test("an admin session's role caps the token; a member session cannot mint at all", async () => {
    const h = await harness();
    // demote the session's person to member: the role check refuses, step-up or not
    await h.db.run((x) => x.orm.update(schema.orgMembers).set({ role: "member" }));
    const su = await h.stepUp("create_api_token", { ...mint, role: "reader" });
    const r = await h.as(h.ONE, "create_api_token", {
      name: "x",
      role: "reader",
      kind: "person",
      expires_in_days: 90,
      step_up: su,
    });
    expect(r.ok).toBe(false);
  });

  test("bearer tokens behave as before, and cannot carry a step-up", async () => {
    const h = await harness();
    const op = (await mintToken(h.db, { orgId: h.org.id }, "operator", { kind: "person" })).secret;
    const ok = await dispatch(h.env, { kind: "bearer", token: op }, "create_api_token", {
      name: "child",
      role: "reader",
      expires_in_days: 5,
    });
    expect(ok.ok).toBe(true);
    const su = await h.stepUp("create_api_token", mint);
    const withSu = await dispatch(h.env, { kind: "bearer", token: op }, "create_api_token", {
      ...mint,
      step_up: su,
    });
    expect(withSu.ok).toBe(false);
    if (!withSu.ok) expect(withSu.error.code).toBe("invalid_input");
    // a bearer cannot ask for a challenge
    const ch = await dispatch(h.env, { kind: "bearer", token: op }, "session_step_up_challenge", {
      action: "create_api_token",
      input: mint,
    });
    expect(ch.ok).toBe(false);
  });

  test("step-up needs the numeric GitHub id to match: same login, different id is refused", async () => {
    const h = await harness({ keyId: "9999" }); // a key enrolled for another account named alice
    const r = await h.as(h.ONE, "session_step_up_challenge", {
      action: "create_api_token",
      input: mint,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
  });

  test("same id, renamed login: the step-up works (the login is display text)", async () => {
    const h = await harness({ login: "alice-renamed" });
    const su = await h.stepUp("create_api_token", mint);
    expect((await h.as(h.ONE, "create_api_token", { ...mint, step_up: su })).ok).toBe(true);
  });

  test("a key with no recorded id can never step up: re-enrol it", async () => {
    const h = await harness({ keyId: null });
    const r = await h.as(h.ONE, "session_step_up_challenge", {
      action: "create_api_token",
      input: mint,
    });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_reenrol");
    if (!r.ok) expect(r.error.message).toContain("re-enrol this passkey");
    // and a step-up issued while the key had an id is refused once the id is gone
    const h2 = await harness();
    const su = await h2.stepUp("create_api_token", mint);
    await h2.db.run((x) => x.orm.update(schema.approvers).set({ githubUserId: null }));
    const call = await h2.as(h2.ONE, "create_api_token", { ...mint, step_up: su });
    expect(reasonOf(call)).toBe("step_up_reenrol");
  });

  const ed25519 = () =>
    generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

  test("bootstrap_approver records the numeric id, and a failed lookup refuses it", async () => {
    const h = await harness();
    const second = await createOrg(h.db, { slug: "second", name: "Second" });
    const tti = (await createInstanceTokenFromCli(h.db, { name: "ops" })).secret;
    const env: DispatchEnv = { ...h.env, allowInstance: true };
    const call = () =>
      dispatch(env, { kind: "bearer", token: tti }, "bootstrap_approver", {
        target_org: "second",
        person: "Zed",
        forge_login: "Zed-Login",
        public_key: ed25519(),
      });
    const rowsOf = () =>
      h.db.run((x) =>
        x.orm.select().from(schema.approvers).where(eq(schema.approvers.orgId, second.id)),
      );
    h.lookup.fail = true;
    expect((await call()).ok).toBe(false);
    expect(await rowsOf()).toHaveLength(0);
    h.lookup.fail = false;
    expect((await call()).ok).toBe(true);
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.githubUserId).toBe("gh-zed-login");
  });

  test("token and session enrolment record the id; a failed lookup refuses a token enrolment", async () => {
    const h = await harness();
    const tok = (await mintToken(h.db, { orgId: h.org.id }, "release_operator")).secret;
    const enrol = (login: string, cred: Parameters<typeof dispatch>[1]) =>
      dispatch(h.env, cred, "request_enrolment", {
        person: login,
        forge_login: login,
        ed25519_public_key: ed25519(),
      });
    h.lookup.fail = true;
    expect((await enrol("carol", { kind: "bearer", token: tok })).ok).toBe(false);
    h.lookup.fail = false;
    expect((await enrol("carol", { kind: "bearer", token: tok })).ok).toBe(true);
    // a session enrolling its own login records the SESSION's id (4004), not a lookup (gh-dave)
    const dave = await createUser(h.db, { displayName: "Dave" });
    await h.db.run((x) =>
      x.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: "4004", userId: dave.id, login: "Dave" }),
    );
    await addMember(h.db, { orgId: h.org.id }, { userId: dave.id, role: "owner" });
    const session = {
      kind: "principal",
      principal: { kind: "session", id: dave.id, orgId: h.org.id, role: "owner" },
    } as const;
    expect((await enrol("dave", session)).ok).toBe(true);
    const rows = await h.db.run((x) => x.orm.select().from(schema.approverEnrolments));
    expect(rows.find((r) => r.forgeLogin === "carol")!.githubUserId).toBe("gh-carol");
    expect(rows.find((r) => r.forgeLogin === "dave")!.githubUserId).toBe("4004");
  });
});

describe("remove_project with delete_history (#577)", () => {
  test("the owner session needs a step-up bound to that exact request; with it the history is deleted, once", async () => {
    const h = await harness();
    const p = await createProject(h.db, { orgId: h.org.id }, { slug: "old", name: "old" });
    const scope = { orgId: h.org.id, projectId: p.id };
    await createRun(h.db, scope, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
    });
    const input = { project: "old", delete_history: true };
    const refused = await h.as(h.ONE, "remove_project", input);
    expect(reasonOf(refused)).toBe("step_up_required");
    // a step-up for a different request does not open it
    const other = await h.stepUp("remove_project", { project: "old", delete_history: false });
    const wrong = await h.as(h.ONE, "remove_project", { ...input, step_up: other });
    expect(reasonOf(wrong)).toBe("step_up_wrong_action");
    expect(await listRuns(h.db, scope)).toHaveLength(1);
    const su = await h.stepUp("remove_project", input);
    const ok = await h.as(h.ONE, "remove_project", { ...input, step_up: su });
    expect(ok.ok).toBe(true);
    expect(await listRuns(h.db, scope)).toEqual([]);
    expect(await getProjectBySlug(h.db, { orgId: h.org.id }, "old")).toBeUndefined();
    const again = await h.as(h.ONE, "remove_project", { ...input, step_up: su });
    expect(again.ok).toBe(false);
  });

  test("without delete_history a session unbinds with no step-up", async () => {
    const h = await harness();
    await createProject(h.db, { orgId: h.org.id }, { slug: "old", name: "old" });
    const r = await h.as(h.ONE, "remove_project", { project: "old" });
    expect(r.ok && r.output).toEqual({ project: "old", unbound: [], deleted: false });
  });
});
