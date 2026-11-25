// Rotating the GitHub App's webhook secret and private key from the web (#586). A software
// passkey signs the step-up; GitHub is a fake that checks the App JWT against known public keys.
// Every key and secret here is generated at runtime.
import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createUser,
  insertApprover,
  listAudit,
  listEvents,
  openDatabase,
  schema,
  type Db,
} from "../src/db";
import { AppAuth, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../src/github/app-auth";
import { createWebhookHandler, WEBHOOK_PATH } from "../src/github/webhook";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { SESSION_STEP_UP_OPS } from "../src/ops/step-up";
import { SecretStore } from "../src/secrets/store";
import { fakeFacts, setup, sign } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const HOUR = 3_600_000;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const rsaPem = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

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

type Reg = { publicKey: string; appId: string };

async function harness() {
  const s = await setup("42", () => {
    const d = openDatabase(":memory:");
    opened.push(d);
    return d;
  });
  const { db, org } = s;
  const store: SecretStore = s.store;
  let t = 1_700_000_000_000;
  // The fake GitHub: GET /app answers with the App whose registered key signed the JWT.
  const registered: Reg[] = [];
  const github = { calls: 0, hookSecrets: [] as string[], refuseHook: false };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    github.calls += 1;
    if (String(url).endsWith("/app/hook/config")) {
      expect(init?.method).toBe("PATCH");
      if (github.refuseHook) return new Response("{}", { status: 422 });
      github.hookSecrets.push((JSON.parse(String(init?.body)) as { secret: string }).secret);
      return new Response("{}", { status: 200 });
    }
    expect(String(url).endsWith("/app")).toBe(true);
    const bearer = String((init?.headers as Record<string, string>).authorization).slice(7);
    const [h, p, sig] = bearer.split(".");
    for (const r of registered) {
      if (
        createVerify("RSA-SHA256")
          .update(`${h}.${p}`)
          .verify(r.publicKey, Buffer.from(sig!, "base64url"))
      ) {
        return new Response(JSON.stringify({ id: Number(r.appId) }), { status: 200 });
      }
    }
    return new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;
  const auth = new AppAuth({ db, store, fetch: fetcher as never, apiBase: "https://gh.test" });
  // The configured App's current key is registered with GitHub.
  const current = (await store.get(org.id, SECRET_PRIVATE_KEY))!;
  registered.push({ publicKey: pubOf(current), appId: "42" });

  const other = await createOrg(db, { slug: "other", name: "Other" });
  const people: Record<string, { cookie: string; dev: ReturnType<typeof passkey> }> = {};
  const live: Record<string, { userId: string; hash: string }> = {};
  let n = 1000;
  /** A signed-in person: a member of `orgId` with `role`, a passkey enrolled in `keyOrgId`. */
  async function person(name: string, orgId: string, role: "owner" | "admin", keyOrgId = orgId) {
    n += 1;
    const user = await createUser(db, { displayName: name });
    await db.run((h) =>
      h.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: String(n), userId: user.id, login: name }),
    );
    await addMember(db, { orgId }, { userId: user.id, role });
    const dev = passkey();
    await insertApprover(
      db,
      keyOrgId,
      {
        person: name,
        forgeLogin: name,
        githubUserId: String(n),
        kind: "webauthn",
        credentialId: dev.credentialId,
        publicKey: dev.spki,
        alg: "ES256",
        createdBy: "test",
      },
      t,
    );
    const cookie = `cookie-${name}-aaaaaaaaaaaaaaaaaaaa`;
    live[cookie] = { userId: user.id, hash: `hash-${name}` };
    people[name] = { cookie, dev };
    return { cookie, dev, userId: user.id };
  }
  const env: DispatchEnv = {
    registry,
    db,
    sessions: { resolve: async (c: string) => live[c] } as unknown as WebSessions,
    webauthn: RP,
    now: () => t,
    auditStore: store,
    appAuth: auth,
    allowInstance: true,
  };
  const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie }, op, input);
  async function stepUp(
    who: { cookie: string; dev: ReturnType<typeof passkey> },
    action: string,
    input: Record<string, unknown>,
  ) {
    const r = await as(who.cookie, "session_step_up_challenge", { action, input });
    if (!r.ok) throw new Error(`challenge refused: ${r.error.message}`);
    const out = r.output as {
      step_up_id: string;
      challenge: string;
      passkeys: { approver: string }[];
    };
    return {
      id: out.step_up_id,
      approver: out.passkeys[0]!.approver,
      signature: who.dev.assert(out.challenge),
    };
  }
  const tti = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const handler = createWebhookHandler({
    db,
    store,
    facts: fakeFacts().facts,
    now: () => t,
    log: () => {},
  });
  const post = async (secret: string) => {
    const body = JSON.stringify({ action: "created", installation: { id: 100 } });
    const res = await handler.handle(
      new Request(`http://x${WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "x-github-event": "ping",
          "x-github-delivery": crypto.randomUUID(),
          "content-type": "application/json",
          "x-hub-signature-256": sign(secret, body),
        },
        body,
      }),
    );
    return res?.status;
  };
  return {
    ...s,
    store,
    person,
    other,
    env,
    tti,
    as,
    stepUp,
    registered,
    github,
    post,
    advance: (ms: number) => (t += ms),
  };
}

function pubOf(pem: string): string {
  return createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
}

const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

const ROTATE = "instance_rotate_webhook_secret";
const REPLACE = "instance_replace_app_private_key";

describe("App-secret ops: who may call", () => {
  test("both are step-up ops, REST only, never MCP tools", () => {
    for (const n of [ROTATE, REPLACE]) {
      expect(SESSION_STEP_UP_OPS.has(n)).toBe(true);
      expect(registry.get(n)!.mcp).toBe(false);
    }
  });

  test("an operator-org owner without a step-up is refused", async () => {
    const h = await harness();
    const o = await h.person("olive", h.org.id, "owner");
    const r = await h.as(o.cookie, ROTATE, {});
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_required");
    const r2 = await h.as(o.cookie, REPLACE, { private_key: "x" });
    expect(reasonOf(r2)).toBe("step_up_required");
  });

  test("a tti_ instance token is refused", async () => {
    const h = await harness();
    for (const [op, input] of [
      [ROTATE, {}],
      [REPLACE, { private_key: "x" }],
    ] as const) {
      const r = await dispatch(h.env, { kind: "bearer", token: h.tti }, op, input);
      expect(r.ok, op).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    }
  });

  test("an org token is refused", async () => {
    const h = await harness();
    const tok = await mintToken(h.db, { orgId: h.org.id }, "release_operator");
    const r = await dispatch(h.env, { kind: "bearer", token: tok.secret }, ROTATE, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  test("an owner of ANOTHER org is refused, even with a valid step-up", async () => {
    const h = await harness();
    const o = await h.person("otto", h.other.id, "owner");
    const su = await h.stepUp(o, ROTATE, {});
    const r = await h.as(o.cookie, ROTATE, { step_up: su });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  test("a passkey enrolled in another org does not step an operator owner up", async () => {
    const h = await harness();
    const o = await h.person("pat", h.org.id, "owner", h.other.id);
    const r = await h.as(o.cookie, "session_step_up_challenge", { action: ROTATE, input: {} });
    expect(r.ok).toBe(false);
  });

  test("a member of the operator org who is not an owner is refused", async () => {
    const h = await harness();
    const m = await h.person("mia", h.org.id, "admin");
    const su = await h.stepUp(m, ROTATE, {});
    const r = await h.as(m.cookie, ROTATE, { step_up: su });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });
});

describe("rotate the webhook secret", () => {
  test("a step-up for different input is refused; a replay is refused", async () => {
    const h = await harness();
    const o = await h.person("olive", h.org.id, "owner");
    const su = await h.stepUp(o, ROTATE, { overlap_minutes: 30 });
    const wrong = await h.as(o.cookie, ROTATE, { overlap_minutes: 60, step_up: su });
    expect(wrong.ok).toBe(false);
    expect(reasonOf(wrong)).toBe("step_up_wrong_action");
    const ok = await h.as(o.cookie, ROTATE, { overlap_minutes: 30, step_up: su });
    expect(ok.ok).toBe(true);
    const again = await h.as(o.cookie, ROTATE, { overlap_minutes: 30, step_up: su });
    expect(again.ok).toBe(false);
    expect(reasonOf(again)).toBe("step_up_reused");
  });

  test("an overlap above one hour is refused", async () => {
    const h = await harness();
    const o = await h.person("olive", h.org.id, "owner");
    const r = await h.as(o.cookie, "session_step_up_challenge", {
      action: ROTATE,
      input: { overlap_minutes: 61 },
    });
    expect(r.ok).toBe(false);
  });

  test("GitHub receives the new secret; both verify inside the window and only the new one after it; no response, log, event or audit holds a secret", async () => {
    const h = await harness();
    const o = await h.person("olive", h.org.id, "owner");
    const old = (await h.store.get(h.org.id, SECRET_WEBHOOK))!;
    const logs: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) => {
      const orig = console[k];
      console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
      return () => (console[k] = orig);
    });
    const su = await h.stepUp(o, ROTATE, {});
    const r = await h.as(o.cookie, ROTATE, { step_up: su });
    spies.forEach((u) => u());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["fingerprint", "overlap_until"]);
    expect(h.github.hookSecrets).toHaveLength(1);
    const fresh = h.github.hookSecrets[0]!;
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    expect(await h.store.get(h.org.id, SECRET_WEBHOOK)).toBe(fresh);
    expect(await h.post(fresh)).toBe(202);
    expect(await h.post(old)).toBe(202);
    h.advance(HOUR - 1);
    expect(await h.post(old)).toBe(202);
    h.advance(2);
    expect(await h.post(old)).toBe(401);
    expect(await h.post(fresh)).toBe(202);
    // The value appears in no response, audit row, event, log line or plaintext column.
    const rows = JSON.stringify(await listAudit(h.db, { orgId: h.org.id }));
    const events = JSON.stringify(
      await listEvents(h.db, { orgId: h.org.id }, { after: 0, limit: 1000 }),
    );
    const raw = await h.db.run((x) => x.orm.select().from(schema.secrets));
    for (const hay of [JSON.stringify(out), rows, events, logs.join("\n"), JSON.stringify(raw)]) {
      expect(hay.includes(fresh)).toBe(false);
      expect(hay.includes(old)).toBe(false);
    }
    expect(rows.includes(out.fingerprint as string)).toBe(true);
    expect(rows.includes('"session"')).toBe(true);
  });

  test("a GitHub refusal restores the old secret and the error says GitHub refused", async () => {
    const h = await harness();
    const o = await h.person("olive", h.org.id, "owner");
    const old = (await h.store.get(h.org.id, SECRET_WEBHOOK))!;
    h.github.refuseHook = true;
    const su = await h.stepUp(o, ROTATE, {});
    const r = await h.as(o.cookie, ROTATE, { step_up: su });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("GitHub refused");
    expect(await h.store.get(h.org.id, SECRET_WEBHOOK)).toBe(old);
    expect(await h.post(old)).toBe(202);
    h.advance(HOUR + 1);
    expect(await h.post(old)).toBe(202);
    expect(h.github.hookSecrets).toHaveLength(0);
  });
});

describe("replace the App private key", () => {
  async function replace(h: Awaited<ReturnType<typeof harness>>, pem: string) {
    const o = await h.person(`olive${Math.random().toString(36).slice(2, 8)}`, h.org.id, "owner");
    const su = await h.stepUp(o, REPLACE, { private_key: pem });
    return h.as(o.cookie, REPLACE, { private_key: pem, step_up: su });
  }

  test("a bad PEM is refused and the old key stays", async () => {
    const h = await harness();
    const before = await h.store.get(h.org.id, SECRET_PRIVATE_KEY);
    const r = await replace(h, "not a key");
    expect(r.ok).toBe(false);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(before);
    expect(h.github.calls).toBe(0);
  });

  test("another App's key, or one GitHub does not know, is refused and the old key stays", async () => {
    const h = await harness();
    const before = await h.store.get(h.org.id, SECRET_PRIVATE_KEY);
    const other = rsaPem();
    h.registered.push({ publicKey: other.publicKey, appId: "99" });
    const r1 = await replace(h, other.privateKey);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.message).toContain("another App");
    const r2 = await replace(h, rsaPem().privateKey);
    expect(r2.ok).toBe(false);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(before);
  });

  test("a new key of the same App is sealed, audited by fingerprint only, never echoed", async () => {
    const h = await harness();
    const fresh = rsaPem();
    h.registered.push({ publicKey: fresh.publicKey, appId: "42" });
    const r = await replace(h, fresh.privateKey);
    expect(r.ok).toBe(true);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(fresh.privateKey);
    const body = fresh.privateKey.split("\n")[1]!;
    expect(JSON.stringify(r.ok ? r.output : null).includes(body)).toBe(false);
    const rows = JSON.stringify(await listAudit(h.db, { orgId: h.org.id }));
    expect(rows.includes(body)).toBe(false);
    if (r.ok) {
      const fp = (r.output as { fingerprint: string }).fingerprint;
      expect(fp).toMatch(/^SHA256:/);
      expect(rows.includes(fp)).toBe(true);
    }
  });
});
