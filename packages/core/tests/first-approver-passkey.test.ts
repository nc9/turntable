// The org's first approver, self-serve (#587): a signed-in org owner enrols a passkey on the
// Approvers page. Every refusal, the race, audit and event, and the unchanged ed25519 bootstrap.
// A software authenticator is built at runtime; the sessions, rows and dispatch are real.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import type { WebSessions } from "../src/auth/web-sessions";
import { generateEd25519 } from "../src/approvals/keys";
import { revokeApproverNotifying } from "../src/approvals/apply";
import {
  addMember,
  createOrg,
  createUser,
  insertApprover,
  listAudit,
  listApprovers,
  listEvents,
  openDatabase,
  schema,
  setKeyPolicy,
  type Db,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { createMcpHttp } from "../src/mcp/http";
import { mintToken } from "./ops-helpers";

const RP = { rpId: "ci.example.test", origins: ["https://ci.example.test"] };
const MIN = 60_000;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
const cbor = {
  int: (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n)),
  bytes: (b: Buffer) => Buffer.concat([head(2, b.length), b]),
  text: (t: string) => Buffer.concat([head(3, Buffer.byteLength(t)), Buffer.from(t)]),
  map: (pairs: [Buffer, Buffer][]) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]),
};

/** A software passkey: ES256, user-verified, attestation "none". */
function passkey() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(32);
  return {
    register(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin: RP.origins[0] }),
      );
      const cose = cbor.map([
        [cbor.int(1), cbor.int(2)],
        [cbor.int(3), cbor.int(-7)],
        [cbor.int(-1), cbor.int(1)],
        [cbor.int(-2), cbor.bytes(Buffer.from(jwk.x, "base64url"))],
        [cbor.int(-3), cbor.bytes(Buffer.from(jwk.y, "base64url"))],
      ]);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(RP.rpId),
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        idLen,
        credentialId,
        cose,
      ]);
      const att = cbor.map([
        [cbor.text("fmt"), cbor.text("none")],
        [cbor.text("attStmt"), cbor.map([])],
        [cbor.text("authData"), cbor.bytes(authData)],
      ]);
      return {
        challenge,
        client_data_json: clientData.toString("base64url"),
        attestation_object: att.toString("base64url"),
      };
    },
  };
}

const opened: Db[] = [];
afterAll(() => {
  for (const db of opened) db.close();
});

async function harness() {
  const db = openDatabase(":memory:");
  opened.push(db);
  const org = await createOrg(db, { slug: "tenant", name: "Tenant" });
  let now = Date.now();
  const people: Record<string, { userId: string; hash: string }> = {};
  const cookies: Record<string, string> = {};
  /** A person with a Turntable role in the org and a web session signed in `agoMs` ago. */
  const person = async (
    name: string,
    role: "owner" | "admin" | "member" | "viewer" | null,
    agoMs = 0,
  ) => {
    const user = await createUser(db, { displayName: name });
    await db.run((h) =>
      h.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: `gh-${name}`, userId: user.id, login: name }),
    );
    if (role) await addMember(db, { orgId: org.id }, { userId: user.id, role });
    const cookie = `cookie-${name}-${"a".repeat(30)}`;
    const hash = `hash-${name}`;
    await db.run((h) =>
      h.orm.insert(schema.webSessions).values({
        id: hash,
        userId: user.id,
        createdAt: now - agoMs,
        lastSeenAt: now,
        expiresAt: now + 86_400_000,
      }),
    );
    people[cookie] = { userId: user.id, hash };
    cookies[name] = cookie;
    return cookie;
  };
  const sessions = { resolve: async (c: string) => people[c] } as unknown as WebSessions;
  const env: DispatchEnv = {
    registry,
    db,
    sessions,
    webauthn: RP,
    allowInstance: true,
    now: () => now,
    githubUsers: { idOfLogin: async (l: string) => `gh-${l.toLowerCase()}` },
  };
  const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
    dispatch(env, { kind: "session", cookie }, op, { org: "tenant", ...input });
  /** The whole ceremony: a challenge, a new passkey, the enrolment. */
  const enrol = async (cookie: string, extra: Record<string, unknown> = {}) => {
    const ch = await as(cookie, "first_approver_challenge");
    if (!ch.ok) return ch;
    const c = (ch.output as { challenge: string }).challenge;
    return as(cookie, "enrol_first_approver", { webauthn: passkey().register(c), ...extra });
  };
  return {
    db,
    org,
    env,
    as,
    enrol,
    person,
    cookies,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error?.code);

describe("enrol_first_approver", () => {
  test("a fresh owner session enrols a passkey bound to their own GitHub login", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const r = await h.enrol(alice);
    expect(r.ok).toBe(true);
    const rows = await listApprovers(h.db, h.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person: "alice",
      forgeLogin: "alice",
      githubUserId: "gh-alice",
      kind: "webauthn",
    });
    expect(rows[0]!.createdBy).toStartWith("session:");
  });

  test("is audited without the passkey blobs, and emits approver.bootstrapped", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const r = await h.enrol(alice);
    expect(r.ok).toBe(true);
    const out = r.ok ? (r.output as { approver_id: string; key_fingerprint: string }) : null;
    const audit = await listAudit(h.db, { orgId: h.org.id });
    const row = audit.find((a) => a.op === "enrol_first_approver");
    expect(row).toBeDefined();
    expect(row!.outcome).toBe("ok");
    expect(JSON.stringify(row)).not.toContain("attestation_object");
    expect(JSON.stringify(row)).toContain(out!.key_fingerprint);
    const events = await listEvents(h.db, { orgId: h.org.id }, { after: 0, limit: 50 });
    const ev = events.filter((e) => e.type === "approver.bootstrapped");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0]!.payload)).toContain(out!.approver_id);
  });

  test("refuses a non-owner (admin, member, viewer) and a non-member", async () => {
    const h = await harness();
    const admin = await h.person("adam", "admin");
    const member = await h.person("mia", "member");
    const viewer = await h.person("vic", "viewer");
    const stranger = await h.person("sam", null);
    for (const c of [admin, member, viewer]) expect(code(await h.enrol(c))).toBe("forbidden");
    expect(code(await h.enrol(stranger))).toBe("not_found");
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(0);
  });

  test("refuses a session whose GitHub sign-in is over 10 minutes old, with a reason", async () => {
    const h = await harness();
    const stale = await h.person("alice", "owner", 11 * MIN);
    const r = await h.as(stale, "first_approver_challenge");
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && (r.error.details as { reason: string }).reason).toBe("fresh_sign_in_required");
    // A challenge fetched while fresh cannot be redeemed after the window closes.
    const fresh = await h.person("bob", "owner", 9 * MIN);
    const ch = await h.as(fresh, "first_approver_challenge");
    expect(ch.ok).toBe(true);
    h.advance(2 * MIN);
    const c = (ch.ok ? (ch.output as { challenge: string }) : { challenge: "" }).challenge;
    const late = await h.as(fresh, "enrol_first_approver", { webauthn: passkey().register(c) });
    expect(!late.ok && (late.error.details as { reason: string }).reason).toBe(
      "fresh_sign_in_required",
    );
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(0);
  });

  test("refuses every token (org of any role, instance) and a cookie-less call", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const ch = await h.as(alice, "first_approver_challenge");
    const c = (ch.ok ? (ch.output as { challenge: string }) : { challenge: "" }).challenge;
    const input = { org: "tenant", webauthn: passkey().register(c) };
    const instance = await createInstanceTokenFromCli(h.db, { name: "ops" });
    const r = await dispatch(
      h.env,
      { kind: "bearer", token: instance.secret },
      "enrol_first_approver",
      input,
    );
    expect(!r.ok && r.error.code).toBe("forbidden");
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const tok = await mintToken(h.db, { orgId: h.org.id }, role);
      for (const op of ["first_approver_challenge", "enrol_first_approver"]) {
        const t = await dispatch(
          h.env,
          { kind: "bearer", token: tok.secret },
          op,
          op === "enrol_first_approver" ? input : { org: "tenant" },
        );
        expect(!t.ok && t.error.code).toBe("forbidden");
      }
    }
    const trusted = await dispatch(
      h.env,
      { kind: "principal", principal: { kind: "member", id: "x", orgId: h.org.id, role: "owner" } },
      "enrol_first_approver",
      input,
    );
    expect(trusted.ok).toBe(false);
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(0);
  });

  test("is not an MCP tool and is refused over MCP", async () => {
    const h = await harness();
    const names = mcpTools(registry).map((t) => t.name);
    expect(names).not.toContain("enrol_first_approver");
    expect(names).not.toContain("first_approver_challenge");
    expect(registry.get("enrol_first_approver")?.mcp).toBe(false);
    const alice = await h.person("alice", "owner");
    const viaMcp = await dispatch(
      { ...h.env, viaMcp: true },
      { kind: "session", cookie: alice },
      "first_approver_challenge",
      { org: "tenant" },
    );
    expect(!viaMcp.ok && viaMcp.error.code).toBe("forbidden");
    expect(createMcpHttp({ registry, db: h.db })).toBeDefined();
  });

  test("refused once the org has an approver", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const bob = await h.person("bob", "owner");
    expect((await h.enrol(alice)).ok).toBe(true);
    expect(code(await h.enrol(bob))).toBe("conflict");
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(1);
  });

  test("refused inside the re-bootstrap delay after the last revocation, allowed after it", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const first = await h.enrol(alice);
    expect(first.ok).toBe(true);
    const id = (first.ok ? (first.output as { approver_id: string }) : { approver_id: "" })
      .approver_id;
    await revokeApproverNotifying(h.db, { id: h.org.id, slug: "tenant" }, id, h.now(), {
      kind: "cli",
      id: "local",
    });
    expect(code(await h.enrol(alice))).toBe("conflict");
    h.advance(25 * 3_600_000);
    const again = await h.person("alice2", "owner");
    expect((await h.enrol(again)).ok).toBe(true);
  });

  test("the key policy applies: hardware refuses an unattested passkey", async () => {
    const h = await harness();
    await setKeyPolicy(
      h.db,
      h.org.id,
      { mode: "hardware", presets: ["yubikey"], aaguids: [] },
      "test",
      h.now(),
    );
    const alice = await h.person("alice", "owner");
    const ch = await h.as(alice, "first_approver_challenge");
    expect(ch.ok && (ch.output as { attestation: string }).attestation).toBe("direct");
    expect(code(await h.enrol(alice))).toBe("invalid_input");
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(0);
  });

  test("a challenge is single use and a wrong or unknown one is refused", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const ch = await h.as(alice, "first_approver_challenge");
    const c = (ch.ok ? (ch.output as { challenge: string }) : { challenge: "" }).challenge;
    const bad = await h.as(alice, "enrol_first_approver", {
      webauthn: passkey().register("x".repeat(40)),
    });
    expect(code(bad)).toBe("conflict");
    const wrongCeremony = await h.as(alice, "enrol_first_approver", {
      webauthn: { ...passkey().register(c), challenge: c, client_data_json: "e30" },
    });
    expect(code(wrongCeremony)).toBe("invalid_input");
    // A refused attempt rolls back with its transaction, so the challenge still serves one good one.
    expect(
      (await h.as(alice, "enrol_first_approver", { webauthn: passkey().register(c) })).ok,
    ).toBe(true);
    // And once spent it cannot be replayed (the org also has an approver now).
    const bob = await h.person("bob", "owner");
    expect(code(await h.as(bob, "enrol_first_approver", { webauthn: passkey().register(c) }))).toBe(
      "conflict",
    );
  });

  test("race: two concurrent enrolments, one wins", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const bob = await h.person("bob", "owner");
    const chA = await h.as(alice, "first_approver_challenge");
    const chB = await h.as(bob, "first_approver_challenge");
    const cA = (chA.ok ? (chA.output as { challenge: string }) : { challenge: "" }).challenge;
    const cB = (chB.ok ? (chB.output as { challenge: string }) : { challenge: "" }).challenge;
    const results = await Promise.all([
      h.as(alice, "enrol_first_approver", { webauthn: passkey().register(cA) }),
      h.as(bob, "enrol_first_approver", { webauthn: passkey().register(cB) }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error.code))).toEqual([
      "conflict",
    ]);
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(1);
    const events = await listEvents(h.db, { orgId: h.org.id }, { after: 0, limit: 50 });
    expect(events.filter((e) => e.type === "approver.bootstrapped")).toHaveLength(1);
  });

  test("race: a passkey enrolment against the instance ed25519 bootstrap, one wins", async () => {
    const h = await harness();
    const alice = await h.person("alice", "owner");
    const instance = await createInstanceTokenFromCli(h.db, { name: "ops" });
    const ch = await h.as(alice, "first_approver_challenge");
    const c = (ch.ok ? (ch.output as { challenge: string }) : { challenge: "" }).challenge;
    const results = await Promise.all([
      h.as(alice, "enrol_first_approver", { webauthn: passkey().register(c) }),
      dispatch(h.env, { kind: "bearer", token: instance.secret }, "bootstrap_approver", {
        target_org: "tenant",
        person: "Carol",
        forge_login: "carol",
        public_key: generateEd25519().publicSpki,
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await listApprovers(h.db, h.org.id)).toHaveLength(1);
  });

  test("the ed25519 bootstrap_approver path is unchanged", async () => {
    const h = await harness();
    const instance = await createInstanceTokenFromCli(h.db, { name: "ops" });
    const r = await dispatch(
      h.env,
      { kind: "bearer", token: instance.secret },
      "bootstrap_approver",
      {
        target_org: "tenant",
        person: "Carol",
        forge_login: "carol",
        public_key: generateEd25519().publicSpki,
      },
    );
    expect(r.ok).toBe(true);
    const rows = await listApprovers(h.db, h.org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ed25519", forgeLogin: "carol" });
    // And the self-serve path now refuses: the org has an approver.
    const alice = await h.person("alice", "owner");
    expect(code(await h.enrol(alice))).toBe("conflict");
    void insertApprover;
  });
});
