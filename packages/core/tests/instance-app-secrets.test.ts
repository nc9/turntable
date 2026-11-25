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
import { systemOrgId } from "../src/audit/failures";
import { AppAuth, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../src/github/app-auth";
import { createWebhookHandler, WEBHOOK_PATH } from "../src/github/webhook";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { INSTANCE_STEP_UP_OPS } from "../src/ops/step-up";
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
  const github = { calls: 0 };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    github.calls += 1;
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

  const user = await createUser(db, { displayName: "Alice" });
  await db.run((h) =>
    h.orm
      .insert(schema.githubIdentities)
      .values({ githubUserId: "1001", userId: user.id, login: "Alice" }),
  );
  await addMember(db, { orgId: org.id }, { userId: user.id, role: "owner" });
  const dev = passkey();
  const enrol = (orgId: string, d: ReturnType<typeof passkey>) =>
    insertApprover(
      db,
      orgId,
      {
        person: "Alice",
        forgeLogin: "alice",
        githubUserId: "1001",
        kind: "webauthn",
        credentialId: d.credentialId,
        publicKey: d.spki,
        alg: "ES256",
        createdBy: "test",
      },
      t,
    );
  const COOKIE = "cookie-one-aaaaaaaaaaaaaaaaaaaa";
  const live: Record<string, { userId: string; hash: string }> = {
    [COOKIE]: { userId: user.id, hash: "hash-one" },
  };
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
  const tti = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  const asInstance = (
    op: string,
    input: Record<string, unknown>,
    cookie: string | undefined = COOKIE,
  ) => dispatch(env, { kind: "bearer", token: tti, sessionCookie: cookie }, op, input);
  async function stepUp(
    action: string,
    input: Record<string, unknown>,
    device: ReturnType<typeof passkey> = dev,
  ) {
    const r = await asInstance("instance_step_up_challenge", { action, input });
    if (!r.ok) throw new Error(`challenge refused: ${r.error.message}`);
    const out = r.output as {
      step_up_id: string;
      challenge: string;
      passkeys: { approver: string }[];
    };
    return {
      id: out.step_up_id,
      approver: out.passkeys[0]!.approver,
      signature: device.assert(out.challenge),
    };
  }
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
    dev,
    enrol,
    env,
    tti,
    COOKIE,
    asInstance,
    stepUp,
    registered,
    github,
    post,
    advance: (ms: number) => (t += ms),
    user,
  };
}

function pubOf(pem: string): string {
  return createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
}

const reasonOf = (r: Awaited<ReturnType<typeof dispatch>>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: string } | undefined)?.reason;

describe("instance App-secret ops: who may call", () => {
  test("the gated ops exist in the registry and are not MCP tools", () => {
    for (const n of INSTANCE_STEP_UP_OPS) {
      const op = registry.get(n);
      expect(op).toBeDefined();
      expect(op!.mcp).toBe(false);
    }
  });

  test("the instance token alone is refused, challenge and action alike", async () => {
    const h = await harness();
    const c = await h.asInstance(
      "instance_step_up_challenge",
      { action: "instance_rotate_webhook_secret", input: {} },
      undefined,
    );
    expect(c.ok).toBe(false);
    expect(reasonOf(c)).toBe("step_up_required");
    const r = await h.asInstance("instance_rotate_webhook_secret", {}, undefined);
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_required");
  });

  test("the instance token with a session but no step-up is refused", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const r = await h.asInstance("instance_rotate_webhook_secret", {});
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_required");
  });

  test("a session alone is refused: it is not the instance administrator", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    for (const op of ["instance_rotate_webhook_secret", "instance_step_up_challenge"]) {
      const r = await dispatch(h.env, { kind: "session", cookie: h.COOKIE }, op, {
        action: "instance_rotate_webhook_secret",
        input: {},
      });
      expect(r.ok, op).toBe(false);
    }
  });

  test("a tenant token is refused", async () => {
    const h = await harness();
    const tok = await mintToken(h.db, { orgId: h.org.id }, "release_operator");
    const r = await dispatch(
      h.env,
      { kind: "bearer", token: tok.secret },
      "instance_rotate_webhook_secret",
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });

  test("a session user with no passkey in the operator org is refused", async () => {
    const h = await harness();
    const r = await h.asInstance("instance_step_up_challenge", {
      action: "instance_rotate_webhook_secret",
      input: {},
    });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_required");
  });

  test("a passkey of ANOTHER org does not count", async () => {
    const h = await harness();
    const other = await createOrg(h.db, { slug: "other", name: "Other" });
    await h.enrol(other.id, h.dev);
    const r = await h.asInstance("instance_step_up_challenge", {
      action: "instance_rotate_webhook_secret",
      input: {},
    });
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toBe("step_up_required");
  });
});

describe("rotate the webhook secret", () => {
  test("a step-up for different input is refused; a replay is refused", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const su = await h.stepUp("instance_rotate_webhook_secret", { overlap_minutes: 30 });
    const wrong = await h.asInstance("instance_rotate_webhook_secret", {
      overlap_minutes: 60,
      step_up: su,
    });
    expect(wrong.ok).toBe(false);
    expect(reasonOf(wrong)).toBe("step_up_wrong_action");
    const ok = await h.asInstance("instance_rotate_webhook_secret", {
      overlap_minutes: 30,
      step_up: su,
    });
    expect(ok.ok).toBe(true);
    const again = await h.asInstance("instance_rotate_webhook_secret", {
      overlap_minutes: 30,
      step_up: su,
    });
    expect(again.ok).toBe(false);
    expect(reasonOf(again)).toBe("step_up_reused");
  });

  test("an overlap above one hour is refused", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const r = await h.asInstance("instance_step_up_challenge", {
      action: "instance_rotate_webhook_secret",
      input: { overlap_minutes: 61 },
    });
    expect(r.ok).toBe(false);
  });

  test("both secrets verify inside the window and only the new one after it; the value is shown once", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const old = (await h.store.get(h.org.id, SECRET_WEBHOOK))!;
    const logs: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) => {
      const orig = console[k];
      console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
      return () => (console[k] = orig);
    });
    const su = await h.stepUp("instance_rotate_webhook_secret", {});
    const r = await h.asInstance("instance_rotate_webhook_secret", { step_up: su });
    spies.forEach((u) => u());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { secret: string; fingerprint: string; overlap_until: string };
    expect(out.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.post(out.secret)).toBe(202);
    expect(await h.post(old)).toBe(202);
    h.advance(HOUR - 1);
    expect(await h.post(old)).toBe(202);
    h.advance(2);
    expect(await h.post(old)).toBe(401);
    expect(await h.post(out.secret)).toBe(202);
    // The value appears in no audit row, event or log line.
    const rows = JSON.stringify(await listAudit(h.db, { orgId: h.org.id }));
    const sys = JSON.stringify(await listAudit(h.db, { orgId: await systemOrgId(h.db) }));
    const events = JSON.stringify(
      await listEvents(h.db, { orgId: h.org.id }, { after: 0, limit: 1000 }),
    );
    for (const hay of [rows, sys, events, logs.join("\n")]) {
      expect(hay.includes(out.secret)).toBe(false);
      expect(hay.includes(old)).toBe(false);
    }
    expect(sys.includes(out.fingerprint)).toBe(true);
    expect(sys.includes(h.user.id)).toBe(true);
    // The sealed row is not plaintext.
    const raw = await h.db.run((x) => x.orm.select().from(schema.secrets));
    expect(JSON.stringify(raw).includes(out.secret)).toBe(false);
  });
});

describe("replace the App private key", () => {
  async function replace(h: Awaited<ReturnType<typeof harness>>, pem: string) {
    const su = await h.stepUp("instance_replace_app_private_key", { private_key: pem });
    return h.asInstance("instance_replace_app_private_key", { private_key: pem, step_up: su });
  }

  test("a bad PEM is refused and the old key stays", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const before = await h.store.get(h.org.id, SECRET_PRIVATE_KEY);
    const r = await replace(h, "not a key");
    expect(r.ok).toBe(false);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(before);
    expect(h.github.calls).toBe(0);
  });

  test("another App's key, or one GitHub does not know, is refused and the old key stays", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const before = await h.store.get(h.org.id, SECRET_PRIVATE_KEY);
    const other = rsaPem();
    h.registered.push({ publicKey: other.publicKey, appId: "99" });
    const r1 = await replace(h, other.privateKey);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.message).toContain("another App");
    const unknown = rsaPem();
    const r2 = await replace(h, unknown.privateKey);
    expect(r2.ok).toBe(false);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(before);
  });

  test("a new key of the same App is sealed, audited by fingerprint only, never echoed", async () => {
    const h = await harness();
    await h.enrol(h.org.id, h.dev);
    const fresh = rsaPem();
    h.registered.push({ publicKey: fresh.publicKey, appId: "42" });
    const r = await replace(h, fresh.privateKey);
    expect(r.ok).toBe(true);
    expect(await h.store.get(h.org.id, SECRET_PRIVATE_KEY)).toBe(fresh.privateKey);
    const body = fresh.privateKey.split("\n")[1]!;
    expect(JSON.stringify(r.ok ? r.output : null).includes(body)).toBe(false);
    const rows = JSON.stringify(await listAudit(h.db, { orgId: h.org.id }));
    const sys = JSON.stringify(await listAudit(h.db, { orgId: await systemOrgId(h.db) }));
    for (const hay of [rows, sys]) expect(hay.includes(body)).toBe(false);
    if (r.ok) expect((r.output as { fingerprint: string }).fingerprint).toMatch(/^SHA256:/);
  });
});
