import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createHash,
  createSign,
  sign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson as canonicalJsonOf } from "../src/audit/chain";
import { approvalsCommand } from "../src/approvals/cli";
import { generateEd25519, parseEd25519PublicKey, signEd25519 } from "../src/approvals/keys";
import { createApprovalVerifier } from "../src/approvals/verifier";
import {
  canonicalStatement,
  challengeOf,
  ENV_STATEMENT_TYPE,
  statementHash,
  type EnvStatement,
} from "../src/approvals/statement";
import { verifyAssertion, verifyRegistration, type RelyingParty } from "../src/approvals/webauthn";
import {
  claimNextAttempt,
  createOrg,
  createPolledRun,
  createProject,
  type Db,
  getJob,
  insertApprover,
  listAudit,
  listJobs,
  openDatabase,
  setEnvPolicy,
  type Scope,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { createRestApi } from "../src/ops/rest";
import { makeCert, type TestCert } from "./helpers/x509";
import { mintToken } from "./ops-helpers";

// ---- a software WebAuthn authenticator ----

const RP: RelyingParty = { rpId: "ci.example.com", origins: ["https://ci.example.com"] };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
const cbor = {
  uint: (n: number) => cborHead(0, n),
  int: (n: number) => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n)),
  bytes: (b: Buffer) => Buffer.concat([cborHead(2, b.length), b]),
  text: (t: string) => Buffer.concat([cborHead(3, Buffer.byteLength(t)), Buffer.from(t)]),
  array: (items: Buffer[]) => Buffer.concat([cborHead(4, items.length), ...items]),
  map: (pairs: [Buffer, Buffer][]) => Buffer.concat([cborHead(5, pairs.length), ...pairs.flat()]),
};

type Soft = {
  credentialId: Buffer;
  register(
    challenge: string,
    o?: Partial<{
      origin: string;
      rpId: string;
      uv: boolean;
      packed: { aaguid: Buffer; leaf: TestCert; tamper?: boolean };
    }>,
  ): {
    clientDataJSON: string;
    attestationObject: string;
  };
  assert(
    challenge: string,
    o?: Partial<{ origin: string; counter: number; uv: boolean; rpId: string }>,
  ): {
    credential_id: string;
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  };
};

function softAuthenticator(): Soft {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(32);
  let counter = 0;
  const flags = (uv: boolean, extra = 0) => 0x01 | (uv ? 0x04 : 0) | extra;
  return {
    credentialId,
    register(challenge, o = {}) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge,
          origin: o.origin ?? RP.origins[0],
        }),
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
        sha256(o.rpId ?? RP.rpId),
        Buffer.from([flags(o.uv ?? true, 0x40)]),
        Buffer.alloc(4),
        o.packed?.aaguid ?? Buffer.alloc(16),
        idLen,
        credentialId,
        cose,
      ]);
      let att: Buffer;
      if (o.packed) {
        const attSig = sign(
          "sha256",
          Buffer.concat([authData, sha256(clientData)]),
          o.packed.leaf.key,
        );
        if (o.packed.tamper) attSig[attSig.length - 1]! ^= 0xff;
        att = cbor.map([
          [cbor.text("fmt"), cbor.text("packed")],
          [
            cbor.text("attStmt"),
            cbor.map([
              [cbor.text("alg"), cbor.int(-7)],
              [cbor.text("sig"), cbor.bytes(attSig)],
              [cbor.text("x5c"), cbor.array([cbor.bytes(o.packed.leaf.der)])],
            ]),
          ],
          [cbor.text("authData"), cbor.bytes(authData)],
        ]);
      } else {
        att = cbor.map([
          [cbor.text("fmt"), cbor.text("none")],
          [cbor.text("attStmt"), cbor.map([])],
          [cbor.text("authData"), cbor.bytes(authData)],
        ]);
      }
      return {
        clientDataJSON: clientData.toString("base64url"),
        attestationObject: att.toString("base64url"),
      };
    },
    assert(challenge, o = {}) {
      counter = o.counter ?? counter + 1;
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? RP.origins[0] }),
      );
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([
        sha256(o.rpId ?? RP.rpId),
        Buffer.from([flags(o.uv ?? true)]),
        c,
      ]);
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

// ---- attestation fixtures (a stand-in vendor root and devices, made at runtime) ----

const TEST_ROOT = makeCert({ cn: "Test Vendor Root", ca: true });
const AAGUID_A = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const AAGUID_B = Buffer.from("fedcba9876543210fedcba9876543210", "hex");
const aaguidText = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const deviceCert = (aaguid: Buffer) =>
  makeCert({
    cn: "Test Device",
    issuer: { cn: "Test Vendor Root", key: TEST_ROOT.key },
    ca: false,
    aaguid,
  });
const ANCHORS = { roots: [TEST_ROOT.cert], intermediates: [] };

// ---- world ----

const WF_HASH = "ab".repeat(32);
const SHA = "c".repeat(40);
let db: Db;
let orgId: string;
let scope: Required<Scope>;
let env: DispatchEnv;
let releaseTok: string;
let operatorTok: string;
let runId: string;
let t = 1_800_000_000_000;
const now = () => t;

type Person = { name: string; id: string; priv: string };
async function ed25519Approver(person: string, forgeLogin?: string | null): Promise<Person> {
  const k = generateEd25519();
  const a = await insertApprover(
    db,
    orgId,
    {
      person,
      forgeLogin: forgeLogin === undefined ? `${person}-gh` : forgeLogin,
      kind: "ed25519",
      publicKey: k.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    t,
  );
  return { name: person, id: a.id, priv: k.privatePem };
}

async function makeRun(opts: { environment?: string; actor?: string; sha?: string } = {}) {
  const planned = {
    key: "deploy",
    id: "deploy",
    name: "deploy",
    needs: [],
    needsIds: [],
    environment: opts.environment ?? "production",
    continueOnError: false,
    outputs: {},
    failFast: true,
  };
  const res = await createPolledRun(db, scope, {
    repo: "acme/app",
    provider: "test",
    now: t,
    run: {
      workflowPath: ".github/workflows/release.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: opts.sha ?? SHA,
      actor: opts.actor ?? "octo",
      trust: JSON.stringify({ class: "protected", workflowHash: WF_HASH }),
    },
    jobs: [{ key: "deploy", name: "deploy", needs: [], planned }],
  });
  return res!.run.id;
}

const call = (tok: string, op: string, input: unknown) =>
  dispatch(env, { kind: "bearer", token: tok }, op, input);
async function ok<T = any>(tok: string, op: string, input: unknown = {}): Promise<T> {
  const r = await call(tok, op, input);
  if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
  return r.output as T;
}

async function challenge(approverId: string, environment = "production", rid = runId) {
  return ok(operatorTok, "approval_challenge", {
    run_id: rid,
    environment,
    approver: approverId,
    project: "app",
  });
}

async function signOffline(p: Person, c: { canonical: string }) {
  return { kind: "ed25519", signature: signEd25519(p.priv, c.canonical) };
}

const approve = (statement: unknown, signature: unknown) =>
  dispatch(env, { kind: "signed" }, "approve_environment", { statement, signature });

beforeEach(async () => {
  t += 1000;
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  orgId = org.id;
  scope = { orgId, projectId: project.id };
  env = { registry, db, now, webauthn: RP, attestationAnchors: ANCHORS };
  releaseTok = (await mintToken(db, { orgId }, "release_operator")).secret;
  operatorTok = (await mintToken(db, { orgId }, "operator")).secret;
  runId = await makeRun();
});

// ---- WebAuthn ----

describe("webauthn verification", () => {
  const challengeB64 = randomBytes(32).toString("base64url");

  test("registration (attestation none) and assertion round-trip", () => {
    const dev = softAuthenticator();
    const reg = verifyRegistration(dev.register(challengeB64), { challenge: challengeB64, rp: RP });
    expect(reg.alg).toBe("ES256");
    expect(reg.credentialId).toBe(dev.credentialId.toString("base64url"));
    const a = dev.assert(challengeB64);
    const r = verifyAssertion(
      {
        credentialId: a.credential_id,
        clientDataJSON: a.client_data_json,
        authenticatorData: a.authenticator_data,
        signature: a.signature,
      },
      { publicKey: reg.publicKey, alg: reg.alg, signCount: 0 },
      { challenge: challengeB64, rp: RP },
    );
    expect(r.signCount).toBe(1);
  });

  test("refuses a wrong origin, challenge, relying party, missing user verification, and a rolled-back counter", () => {
    const dev = softAuthenticator();
    const reg = verifyRegistration(dev.register(challengeB64), { challenge: challengeB64, rp: RP });
    const key = { publicKey: reg.publicKey, alg: reg.alg, signCount: 5 };
    const verify = (a: ReturnType<Soft["assert"]>, ch = challengeB64, k = key) =>
      verifyAssertion(
        {
          credentialId: a.credential_id,
          clientDataJSON: a.client_data_json,
          authenticatorData: a.authenticator_data,
          signature: a.signature,
        },
        k,
        { challenge: ch, rp: RP },
      );
    expect(() =>
      verify(dev.assert(challengeB64, { counter: 6, origin: "https://evil.example" })),
    ).toThrow(/origin/);
    expect(() => verify(dev.assert(challengeB64, { counter: 6 }), "other-challenge")).toThrow(
      /challenge/,
    );
    expect(() => verify(dev.assert(challengeB64, { counter: 6, rpId: "evil.example" }))).toThrow(
      /relying party/,
    );
    expect(() => verify(dev.assert(challengeB64, { counter: 6, uv: false }))).toThrow(
      /user verification/,
    );
    expect(() => verify(dev.assert(challengeB64, { counter: 5 }))).toThrow(/counter/);
    expect(() =>
      verify(dev.assert(challengeB64, { counter: 6 }), challengeB64, {
        ...key,
        publicKey: softKey(),
      }),
    ).toThrow(/does not verify/);
    expect(verify(dev.assert(challengeB64, { counter: 6 })).signCount).toBe(6);
    // Registration refuses a bad origin and a non-"none" format too.
    expect(() =>
      verifyRegistration(dev.register(challengeB64, { origin: "https://evil.example" }), {
        challenge: challengeB64,
        rp: RP,
      }),
    ).toThrow(/origin/);
    expect(() =>
      verifyRegistration(dev.register(challengeB64, { uv: false }), {
        challenge: challengeB64,
        rp: RP,
      }),
    ).toThrow(/user verification/);
  });
});

function softKey(): string {
  return generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
}

// ---- statements ----

describe("approval statement", () => {
  const base: EnvStatement = {
    type: ENV_STATEMENT_TYPE,
    org: "acme",
    project: "app",
    run_id: "r1",
    head_sha: SHA,
    workflow_hash: WF_HASH,
    environment: "production",
    approver: "a1",
    expires_at: 123,
    nonce: "n".repeat(20),
  };
  test("canonical form is key-order independent, and any field change changes the hash and challenge", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as EnvStatement;
    expect(canonicalStatement(reordered)).toBe(canonicalStatement(base));
    for (const change of [
      { head_sha: "d".repeat(40) },
      { workflow_hash: "cd".repeat(32) },
      { environment: "staging" },
      { run_id: "r2" },
      { expires_at: 124 },
      { approver: "a2" },
      { org: "other" },
      { project: "web" },
      { nonce: "m".repeat(20) },
    ]) {
      const s = { ...base, ...change };
      expect(statementHash(s)).not.toBe(statementHash(base));
      expect(challengeOf(s)).not.toBe(challengeOf(base));
    }
    expect(Buffer.from(challengeOf(base), "base64url").toString("hex")).toBe(statementHash(base));
  });
});

// ---- environment approvals ----

describe("two approvers release a production job", () => {
  test("a policy default of two distinct people; one is not enough", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    const waiting = await listJobs(db, scope, runId);
    expect(waiting[0]!.state).toBe("awaiting_approval");
    expect(waiting[0]!.approvalKind).toBe("environment");

    const c1 = await challenge(alice.id);
    const r1 = await approve(c1.statement, await signOffline(alice, c1));
    expect(r1.ok && r1.output).toMatchObject({ approvals: 1, required: 2, released_jobs: 0 });
    expect((await getJob(db, scope, waiting[0]!.id))?.state).toBe("awaiting_approval");
    expect(
      await claimNextAttempt(db, { owner: "w", leaseMs: 1000, now: t, globalCap: 9, perOrgCap: 9 }),
    ).toBeUndefined();

    const c2 = await challenge(bob.id);
    const r2 = await approve(c2.statement, await signOffline(bob, c2));
    expect(r2.ok && r2.output).toMatchObject({ approvals: 2, required: 2, released_jobs: 1 });
    expect((await getJob(db, scope, waiting[0]!.id))?.state).toBe("queued");
    const claim = await claimNextAttempt(db, {
      owner: "w",
      leaseMs: 1000,
      now: t,
      globalCap: 9,
      perOrgCap: 9,
    });
    expect(claim?.job.id).toBe(waiting[0]!.id);
  });

  test("the same person with two keys counts once", async () => {
    const alice1 = await ed25519Approver("alice", "alice-gh");
    const alice2 = await ed25519Approver("alice", "alice-gh");
    const c1 = await challenge(alice1.id);
    await approve(c1.statement, await signOffline(alice1, c1));
    const c2 = await challenge(alice2.id);
    const r = await approve(c2.statement, await signOffline(alice2, c2));
    expect(r.ok && r.output).toMatchObject({ approvals: 1, released_jobs: 0 });
  });

  test("a changed sha, workflow, environment or run invalidates the signature", async () => {
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const sig = await signOffline(alice, c);
    for (const change of [
      { head_sha: "d".repeat(40) },
      { workflow_hash: "cd".repeat(32) },
      { environment: "staging" },
      { run_id: "other" },
      { expires_at: c.statement.expires_at + 1 },
    ]) {
      const r = await approve({ ...c.statement, ...change }, sig);
      expect(r.ok).toBe(false);
    }
    // And a statement signed for the right bindings is refused when the run moved on.
    const stale = await challenge(alice.id);
    const s2 = await signOffline(alice, stale);
    await db.run(async (h) => {
      await h.orm.run(sql`update runs set sha = ${"e".repeat(40)} where id = ${runId}`);
    });
    const r = await approve(stale.statement, s2);
    expect(!r.ok && r.error.code).toBe("conflict");
  });

  test("the run's author cannot approve it; a policy can allow it for solo setups", async () => {
    const author = await ed25519Approver("octocat", "OCTO");
    const other = await ed25519Approver("bob", "bob-gh");
    const c = await challenge(author.id);
    const refused = await approve(c.statement, await signOffline(author, c));
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 1,
      allowAuthorApproval: true,
      by: "t",
      now: t,
    });
    const c2 = await challenge(author.id);
    const solo = await approve(c2.statement, await signOffline(author, c2));
    expect(solo.ok && solo.output).toMatchObject({ approvals: 1, required: 1, released_jobs: 1 });
    void other;
  });

  test("an expired statement is refused, and so is a statement that outlives the limit", async () => {
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const sig = await signOffline(alice, c);
    t += 25 * 3600_000;
    const r = await approve(c.statement, sig);
    expect(!r.ok && r.error.message).toContain("expired");
    // An offline signer can pick any expiry; more than 7 days out is refused.
    const long: EnvStatement = {
      ...c.statement,
      expires_at: t + 8 * 24 * 3600_000,
      nonce: "z".repeat(24),
    };
    const r2 = await approve(long, {
      kind: "ed25519",
      signature: signEd25519(alice.priv, canonicalStatement(long)),
    });
    expect(!r2.ok && r2.error.code).toBe("invalid_input");
  });

  test("a statement is accepted once; a forged or revoked key is refused", async () => {
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const sig = await signOffline(alice, c);
    expect((await approve(c.statement, sig)).ok).toBe(true);
    const replay = await approve(c.statement, sig);
    expect(!replay.ok && replay.error.code).toBe("conflict");
    // A signature from another key.
    const mallory = generateEd25519();
    const c2 = await challenge(alice.id);
    const forged = await approve(c2.statement, {
      kind: "ed25519",
      signature: signEd25519(mallory.privatePem, c2.canonical),
    });
    expect(!forged.ok && forged.error.code).toBe("unauthenticated");
    // Revoked.
    const { revokeApprover } = await import("../src/db");
    await revokeApprover(db, orgId, alice.id, t);
    const c3 = await challenge(alice.id).catch((e: Error) => e);
    expect(c3 instanceof Error).toBe(true);
  });

  test("a policy of three needs three; a non-gated environment is never held", async () => {
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 3,
      allowAuthorApproval: false,
      by: "t",
      now: t,
    });
    const people = [
      await ed25519Approver("a"),
      await ed25519Approver("b"),
      await ed25519Approver("c"),
    ];
    let last: any;
    for (const p of people) {
      const c = await challenge(p.id);
      last = await approve(c.statement, await signOffline(p, c));
    }
    expect(last.output).toMatchObject({ approvals: 3, released_jobs: 1 });
    const other = await makeRun({ environment: "preview", sha: "f".repeat(40) });
    expect((await listJobs(db, scope, other))[0]!.state).toBe("queued");
  });
});

describe("WebAuthn approvals", () => {
  async function passkey(person: string, forge: string = `${person}-gh`) {
    // Enrolled through the same path production uses once a first approver exists.
    const dev = softAuthenticator();
    const ch = await ok(releaseTok, "register_challenge");
    const enrol = await ok(releaseTok, "request_enrolment", {
      person,
      forge_login: forge,
      webauthn: { challenge: ch.challenge, ...snake(dev.register(ch.challenge)) },
    });
    return { dev, enrol };
  }
  const snake = (r: { clientDataJSON: string; attestationObject: string }) => ({
    client_data_json: r.clientDataJSON,
    attestation_object: r.attestationObject,
  });

  test("a passkey approval is bound to a server-issued single-use challenge", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    // Enrol carol's passkey: needs the quorum of the two existing people (min(2, 2)).
    const { dev, enrol } = await passkey("carol", "carol-gh");
    expect(enrol.required).toBe(2);
    for (const p of [alice, bob]) {
      const c = await ok(releaseTok, "enrolment_challenge", {
        enrolment_id: enrol.enrolment_id,
        approver: p.id,
      });
      const r = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
        statement: c.statement,
        signature: await signOffline(p, c),
      });
      expect(r.ok).toBe(true);
    }
    const carol = (await ok(releaseTok, "approvers_overview")).approvers.find(
      (a: any) => a.person === "carol",
    );
    expect(carol.kind).toBe("webauthn");

    const c = await challenge(carol.id);
    expect(c.passkey_id).toBe(dev.credentialId.toString("base64url"));
    expect(c.challenge).toBe(challengeOf(c.statement));
    const assertion = { kind: "webauthn", ...dev.assert(c.challenge) };
    const r = await approve(c.statement, assertion);
    expect(r.ok && r.output).toMatchObject({ approvals: 1 });
    // The same assertion again: the challenge is spent (and the counter would not advance).
    const again = await approve(c.statement, assertion);
    expect(again.ok).toBe(false);
    // An assertion over a different challenge than the statement's hash is refused.
    const c2 = await challenge(carol.id);
    const wrong = await approve(c2.statement, { kind: "webauthn", ...dev.assert(c.challenge) });
    expect(!wrong.ok && wrong.error.code).toBe("unauthenticated");
    // A challenge nobody issued: a statement with a made-up nonce signed by the passkey.
    const made: EnvStatement = { ...c2.statement, nonce: "q".repeat(24) };
    const unissued = await approve(made, { kind: "webauthn", ...dev.assert(challengeOf(made)) });
    expect(!unissued.ok && unissued.error.code).toBe("conflict");
  });

  test("enrolment needs the quorum; one existing approver is not enough once two exist; nobody approves their own key", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    const { enrol } = await passkey("dave");
    const c = await ok(releaseTok, "enrolment_challenge", {
      enrolment_id: enrol.enrolment_id,
      approver: alice.id,
    });
    const one = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
      statement: c.statement,
      signature: await signOffline(alice, c),
    });
    expect(one.ok && one.output).toMatchObject({ approvals: 1, required: 2, activated: false });
    expect(
      (await ok(releaseTok, "approvers_overview")).approvers.map((a: any) => a.person),
    ).not.toContain("dave");
    const c2 = await ok(releaseTok, "enrolment_challenge", {
      enrolment_id: enrol.enrolment_id,
      approver: bob.id,
    });
    const two = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
      statement: c2.statement,
      signature: await signOffline(bob, c2),
    });
    expect(two.ok && two.output).toMatchObject({ approvals: 2, activated: true });
    expect(
      (await ok(releaseTok, "approvers_overview")).approvers.map((a: any) => a.person),
    ).toContain("dave");
  });

  test("the first approver cannot come from the API", async () => {
    const r = await call(releaseTok, "request_enrolment", {
      person: "x",
      forge_login: "x-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toContain("CLI");
  });
});

// ---- nothing but a signature approves ----

describe("no token, session or MCP call can approve", () => {
  test("every token and principal is refused for the signature ops", async () => {
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const input = { statement: c.statement, signature: await signOffline(alice, c) };
    for (const tok of [releaseTok, operatorTok]) {
      for (const op of ["approve_environment", "approve_enrolment"]) {
        const r = await call(tok, op, input);
        expect(!r.ok && r.error.code).toBe("signature_required");
      }
    }
    const member = await dispatch(
      env,
      { kind: "principal", principal: { kind: "member", id: "o", orgId, role: "owner" } },
      "approve_environment",
      input,
    );
    expect(!member.ok && member.error.code).toBe("signature_required");
    // The old untrusted-author approval does not release an environment gate either.
    const run = await call(releaseTok, "approve_run", {
      run_id: runId,
      head_sha: SHA,
      workflow_hash: WF_HASH,
    });
    expect(run.ok).toBe(false);
    expect((await listJobs(db, scope, runId))[0]!.state).toBe("awaiting_approval");
  });

  test("a signed credential is refused for token ops, and an approver principal never reaches them", async () => {
    const r = await dispatch(env, { kind: "signed" }, "cancel", { run_id: runId });
    expect(!r.ok && r.error.code).toBe("forbidden");
  });

  test("over REST the signature ops take no bearer token and ignore one", async () => {
    const api = createRestApi(env);
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const body = JSON.stringify({ statement: c.statement, signature: await signOffline(alice, c) });
    const bad = await api(
      new Request("http://x/api/v1/approvals", {
        method: "POST",
        headers: { authorization: `Bearer ${releaseTok}` },
        body: JSON.stringify({
          statement: c.statement,
          signature: { kind: "ed25519", signature: "AAAA" },
        }),
      }),
    );
    expect(bad?.status).toBe(401);
    const good = await api(new Request("http://x/api/v1/approvals", { method: "POST", body }));
    expect(good?.status).toBe(200);
    expect((await good!.json()) as any).toMatchObject({ approvals: 1 });
  });

  test("MCP: no tool creates a statement or signs, and the relay carries only signed bytes", async () => {
    const names = mcpTools(registry).map((t) => t.name);
    for (const hidden of [
      "approval_challenge",
      "enrolment_challenge",
      "register_challenge",
      "request_enrolment",
      "approve_environment",
      "approve_enrolment",
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(names).toContain("submit_approval");
    const alice = await ed25519Approver("alice");
    const bob = await ed25519Approver("bob");
    const c = await challenge(alice.id);
    // A token without a human's signature approves nothing.
    const unsigned = await call(operatorTok, "submit_approval", {
      statement: c.statement,
      signature: {
        kind: "ed25519",
        signature: signEd25519(generateEd25519().privatePem, c.canonical),
      },
      project: "app",
    });
    expect(!unsigned.ok && unsigned.error.code).toBe("unauthenticated");
    // Relaying a statement a human signed works, and counts like any other approval.
    const relayed = await call(operatorTok, "submit_approval", {
      statement: c.statement,
      signature: await signOffline(alice, c),
      project: "app",
    });
    expect(relayed.ok && relayed.output).toMatchObject({ approvals: 1 });
    // The relay cannot alter the statement.
    const c2 = await challenge(bob.id);
    const altered = await call(operatorTok, "submit_approval", {
      statement: { ...c2.statement, environment: "staging" },
      signature: await signOffline(bob, c2),
      project: "app",
    });
    expect(altered.ok).toBe(false);
  });
});

// ---- the verifier the release lane calls ----

describe("ApprovalVerifier", () => {
  const subject = () => ({
    orgId,
    projectId: scope.projectId,
    runId,
    headSha: SHA,
    workflowHash: WF_HASH,
  });

  test("re-verifies stored approvals and requires the policy's distinct people", async () => {
    const verifier = createApprovalVerifier(db, { rp: RP });
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    expect((await verifier.verify(subject(), "production", { now: t })).approved).toBe(false);
    for (const p of [alice, bob]) {
      const c = await challenge(p.id);
      await approve(c.statement, await signOffline(p, c));
    }
    const v = await verifier.verify(subject(), "production", { now: t });
    expect(v.approved && v.approvals.map((a) => a.person).toSorted()).toEqual(["alice", "bob"]);
    // A different sha or workflow is not the approved subject.
    const moved = await verifier.verify({ ...subject(), headSha: "d".repeat(40) }, "production", {
      now: t,
    });
    expect(!moved.approved && moved.reason).toBe("sha_mismatch");
    // Expired approvals do not count.
    const later = await verifier.verify(subject(), "production", { now: t + 48 * 3600_000 });
    expect(!later.approved && later.reason).toBe("expired");
    // Another environment has no approvals.
    expect((await verifier.verify(subject(), "staging", { now: t })).approved).toBe(false);
  });

  test("uses the caller's own key store, so a key the release lane does not trust does not count", async () => {
    const verifier = createApprovalVerifier(db, { rp: RP });
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    for (const p of [alice, bob]) {
      const c = await challenge(p.id);
      await approve(c.statement, await signOffline(p, c));
    }
    const trustAliceOnly = {
      async lookup(id: string) {
        const a = (await import("../src/db")).getApprover;
        const row = await a(db, orgId, id);
        return row && id === alice.id ? { ...row, revoked: false } : undefined;
      },
    };
    const v = await verifier.verify(subject(), "production", { now: t, keys: trustAliceOnly });
    expect(!v.approved && v.have).toBe(1);
    // A key revoked later stops counting even though its statement is stored.
    const { revokeApprover } = await import("../src/db");
    await revokeApprover(db, orgId, bob.id, t);
    const v2 = await verifier.verify(subject(), "production", { now: t });
    expect(!v2.approved && v2.have).toBe(1);
  });

  test("a tampered stored statement or signature is not counted", async () => {
    const verifier = createApprovalVerifier(db, { rp: RP });
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    for (const p of [alice, bob]) {
      const c = await challenge(p.id);
      await approve(c.statement, await signOffline(p, c));
    }
    const forged = JSON.stringify({ kind: "ed25519", signature: "AAAA" });
    await db.run(async (h) => {
      await h.orm.run(sql`update approval_records set signature = ${forged} where person = 'bob'`);
    });
    const v = await verifier.verify(subject(), "production", { now: t });
    expect(!v.approved && v.have).toBe(1);
  });
});

// ---- offline signature round trip and CLI ----

describe("offline signature and CLI", () => {
  test("keygen, bootstrap, sign and approve round-trip through the CLI helpers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-approvals-"));
    const file = openDatabase(join(dir, "longshore.db"));
    await createOrg(file, { slug: "cli-org", name: "Cli" });
    file.close();
    const logs: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (m: string) => void logs.push(m);
    console.error = () => {};
    try {
      const keyFile = join(dir, "approver.pem");
      expect(await approvalsCommand(["keygen", "--out", keyFile])).toBe(0);
      const pub = logs.at(-1)!;
      expect(parseEd25519PublicKey(pub)).toBe(pub);
      expect(await approvalsCommand(["keygen", "--out", keyFile])).toBe(1); // never overwrites a key
      // Before any approver exists the CLI is the local trust root and may set the policy.
      const kp0 = (...a: string[]) =>
        approvalsCommand(["key-policy", "--org", "cli-org", "--data-dir", dir, ...a]);
      expect(await kp0("--policy", "bogus")).toBe(2);
      expect(await kp0("--policy", "hardware", "--preset", "yubikey")).toBe(0);
      expect(await kp0("--policy", "any")).toBe(0);
      expect(JSON.parse(logs.at(-1)!)).toEqual({ mode: "any", presets: [], aaguids: [] });
      expect(
        await approvalsCommand([
          "bootstrap",
          "--org",
          "cli-org",
          "--person",
          "alice",
          "--forge-login",
          "alice-gh",
          "--public-key",
          pub,
          "--data-dir",
          dir,
        ]),
      ).toBe(0);
      // The key policy can be set from the CLI only while the org has no approver; after that it
      // takes a quorum-signed statement.
      const kp = (...a: string[]) =>
        approvalsCommand(["key-policy", "--org", "cli-org", "--data-dir", dir, ...a]);
      expect(await kp("--policy", "hardware", "--preset", "yubikey")).toBe(1);
      expect(await kp("--policy", "any")).toBe(1);
      // A second bootstrap is refused: after the first approver, enrolment needs a quorum.
      expect(
        await approvalsCommand([
          "bootstrap",
          "--org",
          "cli-org",
          "--person",
          "mallory",
          "--forge-login",
          "mallory-gh",
          "--public-key",
          pub,
          "--data-dir",
          dir,
        ]),
      ).toBe(1);
      // A forge login is required: without it an approval could not be told from the author's.
      expect(
        await approvalsCommand([
          "bootstrap",
          "--org",
          "cli-org",
          "--person",
          "x",
          "--public-key",
          pub,
          "--data-dir",
          dir,
        ]),
      ).toBe(2);
      expect(
        await approvalsCommand([
          "policy",
          "--org",
          "cli-org",
          "--environment",
          "production",
          "--required",
          "1",
          "--data-dir",
          dir,
        ]),
      ).toBe(0);
      const stmt = join(dir, "statement.json");
      await Bun.write(stmt, JSON.stringify({ canonical: '{"x":1}' }));
      expect(await approvalsCommand(["sign", "--key", keyFile, "--statement", stmt])).toBe(0);
      const sig = JSON.parse(logs.at(-1)!);
      expect(sig.kind).toBe("ed25519");
      const { verifyEd25519 } = await import("../src/approvals/keys");
      expect(verifyEd25519(pub, '{"x":1}', sig.signature)).toBe(true);
    } finally {
      console.log = log;
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- tenant binding, the author check failing closed, and the weak-setup warning ----

describe("review hardening", () => {
  async function otherOrgAndProject() {
    const other = await createOrg(db, { slug: "globex", name: "Globex" });
    const otherProject = await createProject(db, { orgId }, { slug: "web", name: "Web" });
    return { other, otherProject };
  }

  test("a statement that names another org or another project is refused, even when otherwise valid", async () => {
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const { other } = await otherOrgAndProject();
    // Another org: the key is not enrolled there, so the signature is not accepted at all...
    const wrongOrg: EnvStatement = { ...c.statement, org: other.slug };
    const r1 = await approve(wrongOrg, {
      kind: "ed25519",
      signature: signEd25519(alice.priv, canonicalStatement(wrongOrg)),
    });
    expect(r1.ok).toBe(false);
    // ...and applying it directly to this scope (a token relay, or a bug) is refused as a conflict.
    const relay = await call(operatorTok, "submit_approval", {
      statement: wrongOrg,
      signature: {
        kind: "ed25519",
        signature: signEd25519(alice.priv, canonicalStatement(wrongOrg)),
      },
      project: "app",
    });
    expect(relay.ok).toBe(false);
    // Another project of the same org: signed by a valid key, for a project the run is not in.
    const wrongProject: EnvStatement = { ...c.statement, project: "web", nonce: "p".repeat(24) };
    const sig = {
      kind: "ed25519",
      signature: signEd25519(alice.priv, canonicalStatement(wrongProject)),
    };
    const r2 = await approve(wrongProject, sig);
    expect(r2.ok).toBe(false);
    const viaRelay = await call(operatorTok, "submit_approval", {
      statement: wrongProject,
      signature: sig,
      project: "app",
    });
    expect(!viaRelay.ok && viaRelay.error.code).toBe("forbidden");
    // The same statement bound to the right org and project works.
    const right = await approve(c.statement, await signOffline(alice, c));
    expect(right.ok).toBe(true);
  });

  test("the tenant check lives in the apply step too, not only at the edges", async () => {
    const { applyEnvironmentApproval } = await import("../src/approvals/apply");
    const alice = await ed25519Approver("alice");
    const c = await challenge(alice.id);
    const forProject: EnvStatement = { ...c.statement, project: "web", nonce: "q".repeat(24) };
    await expect(
      applyEnvironmentApproval({ db, scope, now: t, rp: RP }, forProject, {
        kind: "ed25519",
        signature: signEd25519(alice.priv, canonicalStatement(forProject)),
      }),
    ).rejects.toThrow(/another project/);
    const forOrg: EnvStatement = { ...c.statement, org: "globex", nonce: "r".repeat(24) };
    await expect(
      applyEnvironmentApproval({ db, scope, now: t, rp: RP }, forOrg, {
        kind: "ed25519",
        signature: signEd25519(alice.priv, canonicalStatement(forOrg)),
      }),
    ).rejects.toThrow(/another org/);
  });

  test("the author check fails closed: an approver with no forge login, or a run with no author, is refused", async () => {
    const noLogin = await ed25519Approver("nologin", null);
    const c = await challenge(noLogin.id);
    const r = await approve(c.statement, await signOffline(noLogin, c));
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && r.error.message).toContain("no forge login");
    // A run whose author is unknown.
    const anon = await makeRun({ sha: "9".repeat(40) });
    await db.run(async (h) => {
      await h.orm.run(sql`update runs set actor = NULL where id = ${anon}`);
    });
    const bob = await ed25519Approver("bob");
    // With a quorum of one, an unknown author cannot be told from the approver: refused. (With a
    // quorum of two the quorum itself guarantees a second person: see the next describe.)
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 1,
      allowAuthorApproval: false,
      by: "t",
      now: t,
    });
    const c2 = await challenge(bob.id, "production", anon);
    const r2 = await approve(c2.statement, await signOffline(bob, c2));
    expect(!r2.ok && r2.error.code).toBe("forbidden");
    expect(!r2.ok && r2.error.message).toContain("cannot establish");
    // The solo policy waives the check, as documented.
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 1,
      allowAuthorApproval: true,
      by: "t",
      now: t,
    });
    // It waives the author check, not the need for an identity: a key with no login still counts
    // for nothing, while one with a login may approve.
    const c3 = await challenge(noLogin.id);
    const r3 = await approve(c3.statement, await signOffline(noLogin, c3));
    expect(!r3.ok && r3.error.code).toBe("forbidden");
    const c4 = await challenge(bob.id);
    expect((await approve(c4.statement, await signOffline(bob, c4))).ok).toBe(true);
  });

  test("the verifier does not count an approval it cannot show is not the author's", async () => {
    const verifier = createApprovalVerifier(db, { rp: RP });
    const alice = await ed25519Approver("alice");
    const bob = await ed25519Approver("bob");
    for (const p of [alice, bob]) {
      const c = await challenge(p.id);
      await approve(c.statement, await signOffline(p, c));
    }
    const subject = {
      orgId,
      projectId: scope.projectId,
      runId,
      headSha: SHA,
      workflowHash: WF_HASH,
    };
    expect((await verifier.verify(subject, "production", { now: t })).approved).toBe(true);
    // The run's author becomes unknown after the fact: the approvals stop counting, whatever the
    // quorum (only a tag run the poller made has an author unknown by construction).
    await db.run(async (h) => {
      await h.orm.run(sql`update runs set actor = NULL where id = ${runId}`);
    });
    const v = await verifier.verify(subject, "production", { now: t });
    expect(!v.approved && v.reason).toBe("self_approval");
  });

  describe("a run whose author is unknown", () => {
    /** A run with no author that is not a tag run: it stays unknown whatever the quorum. */
    const anonRun = async (sha: string) => {
      const id = await makeRun({ sha });
      await db.run(async (h) => {
        await h.orm.run(sql`update runs set actor = NULL where id = ${id}`);
      });
      return id;
    };
    /** A run the poller made from a tag: no author, the trust facts name the tag, the ref is its ref. */
    const tagRun = async (sha: string, taggerLabel?: string) => {
      const id = await makeRun({ sha });
      const facts = JSON.stringify({ tag: "v1.0.0", ...(taggerLabel ? { taggerLabel } : {}) });
      await db.run(async (h) => {
        await h.orm.run(
          sql`update runs set actor = NULL, ref = 'refs/tags/v1.0.0', trust = json_set(trust, '$.facts', json(${facts})) where id = ${id}`,
        );
      });
      return id;
    };
    const subject = (rid: string, sha: string) => ({
      orgId,
      projectId: scope.projectId,
      runId: rid,
      headSha: sha,
      workflowHash: WF_HASH,
    });
    const authorAudits = async () =>
      (await listAudit(db, scope)).filter((a) => a.op === "approval_author_unknown");

    test("a tag run with a quorum of two needs three distinct approvers, and the audit says why", async () => {
      const rid = await tagRun("8".repeat(40));
      const alice = await ed25519Approver("alice");
      const bob = await ed25519Approver("bob");
      const carol = await ed25519Approver("carol");
      const verify = () =>
        createApprovalVerifier(db, { rp: RP }).verify(subject(rid, "8".repeat(40)), "production", {
          now: t,
        });
      const c1 = await challenge(alice.id, "production", rid);
      const first = await approve(c1.statement, await signOffline(alice, c1));
      expect(first.ok && first.output).toMatchObject({
        approvals: 1,
        required: 3,
        released_jobs: 0,
      });
      const c2 = await challenge(bob.id, "production", rid);
      const second = await approve(c2.statement, await signOffline(bob, c2));
      // the environment says 2, but the author is unknown, so two are not enough
      expect(second.ok && second.output).toMatchObject({
        approvals: 2,
        required: 3,
        released_jobs: 0,
      });
      expect(await authorAudits()).toEqual([]);
      const refused = await verify();
      expect(!refused.approved && refused.required).toBe(3);
      expect(refused.approved).toBe(false);
      const c3 = await challenge(carol.id, "production", rid);
      const third = await approve(c3.statement, await signOffline(carol, c3));
      expect(third.ok && third.output).toMatchObject({
        approvals: 3,
        required: 3,
        released_jobs: 1,
      });
      const [a] = await authorAudits();
      expect(a).toMatchObject({ outcome: "ok" });
      const input = JSON.parse(a!.input);
      expect(input).toMatchObject({
        run: rid,
        environment: "production",
        note: "author unknown; required 3 distinct approvers (2+1)",
      });
      expect(input.approvers).toHaveLength(3);
      // the verifier (what signing asks) agrees
      expect((await verify()).approved).toBe(true);
    });

    test("a run with no author that is NOT a tag run stays unknown, even with a quorum of two", async () => {
      const rid = await anonRun("5".repeat(40));
      const alice = await ed25519Approver("alice");
      const c = await challenge(alice.id, "production", rid);
      const r = await approve(c.statement, await signOffline(alice, c));
      expect(!r.ok && r.error.code).toBe("forbidden");
      expect(!r.ok && r.error.message).toContain("cannot establish");
      expect(await authorAudits()).toEqual([]);
      // a tag-looking ref alone is not enough: the facts must name the tag
      await db.run(async (h) => {
        await h.orm.run(sql`update runs set ref = 'refs/tags/v1.0.0' where id = ${rid}`);
      });
      const c2 = await challenge(alice.id, "production", rid);
      expect((await approve(c2.statement, await signOffline(alice, c2))).ok).toBe(false);
      // and facts naming a tag on a run whose ref is something else are not enough either
      const odd = await anonRun("4".repeat(40));
      await db.run(async (h) => {
        await h.orm.run(
          sql`update runs set trust = json_set(trust, '$.facts', json('{"tag":"v1.0.0"}')) where id = ${odd}`,
        );
      });
      const c3 = await challenge(alice.id, "production", odd);
      expect((await approve(c3.statement, await signOffline(alice, c3))).ok).toBe(false);
    });

    test("the tagger label is not a signal: an approver whose login equals it counts like any other", async () => {
      const rid = await tagRun("3".repeat(40), "Alice-GH");
      const alice = await ed25519Approver("alice", "alice-gh");
      const bob = await ed25519Approver("bob");
      const carol = await ed25519Approver("carol");
      let last: unknown;
      for (const p of [alice, bob, carol]) {
        const c = await challenge(p.id, "production", rid);
        const r = await approve(c.statement, await signOffline(p, c));
        expect(r.ok).toBe(true);
        last = r.ok ? r.output : undefined;
      }
      expect(last).toMatchObject({ approvals: 3, required: 3, released_jobs: 1 });
    });

    test("a tag run with a quorum of one needs two distinct approvers, and the solo policy needs one", async () => {
      const rid = await tagRun("6".repeat(40));
      const alice = await ed25519Approver("alice");
      const bob = await ed25519Approver("bob");
      await setEnvPolicy(db, orgId, {
        environment: "production",
        required: 1,
        allowAuthorApproval: false,
        by: "t",
        now: t,
      });
      const c = await challenge(alice.id, "production", rid);
      const one = await approve(c.statement, await signOffline(alice, c));
      expect(one.ok && one.output).toMatchObject({ approvals: 1, required: 2, released_jobs: 0 });
      const c1 = await challenge(bob.id, "production", rid);
      const two = await approve(c1.statement, await signOffline(bob, c1));
      expect(two.ok && two.output).toMatchObject({ approvals: 2, required: 2, released_jobs: 1 });
      expect((await authorAudits())[0]).toBeDefined();
      // the solo policy is explicit about the author rule: one approver, no note
      const solo = await tagRun("9".repeat(40));
      await setEnvPolicy(db, orgId, {
        environment: "production",
        required: 1,
        allowAuthorApproval: true,
        by: "t",
        now: t,
      });
      const before = (await authorAudits()).length;
      const c2 = await challenge(alice.id, "production", solo);
      const s = await approve(c2.statement, await signOffline(alice, c2));
      expect(s.ok && s.output).toMatchObject({ approvals: 1, required: 1, released_jobs: 1 });
      expect((await authorAudits()).length).toBe(before);
    });

    test("one person with two keys is one identity, so it is not a quorum", async () => {
      const rid = await tagRun("7".repeat(40));
      const alice = await ed25519Approver("alice", "alice-gh");
      const alice2 = await ed25519Approver("alice-second-key", "bob-gh");
      // Rows from before the identity rule: a second key on the same login.
      await db.run(async (h) => {
        await h.orm.run(sql`update approvers set forge_login = 'Alice-GH' where id = ${alice2.id}`);
      });
      for (const p of [alice, alice2]) {
        const c = await challenge(p.id, "production", rid);
        await approve(c.statement, await signOffline(p, c));
      }
      expect(await authorAudits()).toEqual([]);
      expect(
        (
          await createApprovalVerifier(db, { rp: RP }).verify(
            subject(rid, "7".repeat(40)),
            "production",
            { now: t },
          )
        ).approved,
      ).toBe(false);
    });

    test("a KNOWN author still cannot approve, whatever the quorum", async () => {
      const author = await ed25519Approver("octocat", "OCTO");
      const c = await challenge(author.id);
      const refused = await approve(c.statement, await signOffline(author, c));
      expect(!refused.ok && refused.error.message).toContain("author of a run cannot approve");
    });
  });

  test("enrolment requires a forge login", async () => {
    await ed25519Approver("alice");
    const r = await call(releaseTok, "request_enrolment", {
      person: "carl",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(!r.ok && r.error.code).toBe("invalid_input");
    const ok2 = await call(releaseTok, "request_enrolment", {
      person: "carl",
      forge_login: "carl-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(ok2.ok).toBe(true);
  });

  test("a setup with fewer approvers than an environment needs says so, in the API and the CLI", async () => {
    const empty = await ok(releaseTok, "approvers_overview");
    expect(empty.warnings.join(" ")).toContain("No approver is enrolled");
    await ed25519Approver("alice");
    const one = await ok(releaseTok, "approvers_overview");
    expect(one.warnings.join(" ")).toContain("need 2 distinct people but only 1 is enrolled");
    expect(one.warnings.join(" ")).toContain("sole approver can enrol more keys alone");
    await ed25519Approver("bob");
    expect((await ok(releaseTok, "approvers_overview")).warnings).toEqual([]);
    // A policy of one needs no second person.
    const { approvalWarnings } = await import("../src/approvals/apply");
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 1,
      allowAuthorApproval: false,
      by: "t",
      now: t,
    });
    await setEnvPolicy(db, orgId, {
      environment: "release",
      required: 1,
      allowAuthorApproval: false,
      by: "t",
      now: t,
    });
    expect(await approvalWarnings(db, orgId, ["production", "release"])).toEqual([]);
  });
  describe("identity is the verified forge login, not the person label (fix)", () => {
    test("two people rows that share one forge login count as one approver", async () => {
      const alice = await ed25519Approver("alice", "alice-gh");
      const bob = await ed25519Approver("bob", "bob-gh");
      // Rows from before the identity rule: a second label on the same login.
      await db.run(async (h) => {
        await h.orm.run(sql`update approvers set forge_login = 'Alice-GH' where id = ${bob.id}`);
      });
      const c1 = await challenge(alice.id);
      await approve(c1.statement, await signOffline(alice, c1));
      const c2 = await challenge(bob.id);
      const r = await approve(c2.statement, await signOffline(bob, c2));
      expect(r.ok && r.output).toMatchObject({ approvals: 1, required: 2, released_jobs: 0 });
      // The verifier counts the same way.
      const v = await createApprovalVerifier(db, { rp: RP }).verify(
        { orgId, projectId: scope.projectId, runId, headSha: SHA, workflowHash: WF_HASH },
        "production",
        { now: t },
      );
      expect(v.approved).toBe(false);
    });

    test("an impersonation enrolment is refused: a held login under another label, any case", async () => {
      await ed25519Approver("alice", "alice-gh");
      const r = await call(releaseTok, "request_enrolment", {
        person: "mallory",
        forge_login: "ALICE-GH",
        ed25519_public_key: generateEd25519().publicSpki,
      });
      expect(!r.ok && r.error.code).toBe("conflict");
      // Direct inserts (the CLI bootstrap path) are held to the same rule.
      await expect(
        insertApprover(
          db,
          orgId,
          {
            person: "mallory",
            forgeLogin: "Alice-Gh",
            kind: "ed25519",
            publicKey: generateEd25519().publicSpki,
            alg: "EdDSA",
            createdBy: "t",
          },
          t,
        ),
      ).rejects.toThrow(/already belongs/);
      // A second key for the same human (same label and login) is fine.
      const again = await call(releaseTok, "request_enrolment", {
        person: "alice",
        forge_login: "Alice-GH",
        ed25519_public_key: generateEd25519().publicSpki,
      });
      expect(again.ok).toBe(true);
    });

    test("the enrolment quorum is over identities, excluding the enrolee only by the same login", async () => {
      const alice = await ed25519Approver("alice", "alice-gh");
      await ed25519Approver("bob", "bob-gh");
      const second = await ok(releaseTok, "request_enrolment", {
        person: "alice",
        forge_login: "ALICE-gh",
        ed25519_public_key: generateEd25519().publicSpki,
      });
      // alice's own new key: only bob is "another", so the quorum is 1, and alice cannot be it.
      expect(second.required).toBe(1);
      const c = await ok(releaseTok, "enrolment_challenge", {
        enrolment_id: second.enrolment_id,
        approver: alice.id,
      });
      const self = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
        statement: c.statement,
        signature: await signOffline(alice, c),
      });
      expect(!self.ok && self.error.code).toBe("forbidden");
    });

    test("the enrolment statement carries the forge login, and a different one is not for this enrolment", async () => {
      const alice = await ed25519Approver("alice", "alice-gh");
      await ed25519Approver("bob", "bob-gh");
      const e = await ok(releaseTok, "request_enrolment", {
        person: "carl",
        forge_login: "Carl-GH",
        ed25519_public_key: generateEd25519().publicSpki,
      });
      const c = await ok(releaseTok, "enrolment_challenge", {
        enrolment_id: e.enrolment_id,
        approver: alice.id,
      });
      expect(c.statement.forge_login).toBe("carl-gh");
      const overview = await ok(releaseTok, "approvers_overview");
      expect(overview.pending_enrolments[0].forge_login).toBe("Carl-GH");
      // A statement naming another login is a different statement: it fails the enrolment match
      // (its signature would be over other text, so sign the altered one).
      const altered = { ...c.statement, forge_login: "someone-else" };
      const sig = { kind: "ed25519", signature: signEd25519(alice.priv, canonicalJsonOf(altered)) };
      const r = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
        statement: altered,
        signature: sig,
      });
      expect(!r.ok && r.error.code).toBe("conflict");
    });
  });

  describe("open challenges are capped per principal and expired rows are purged", () => {
    test("one token filling its cap does not block another, and expiry frees the cap", async () => {
      await ed25519Approver("alice", "alice-gh");
      const other = (await mintToken(db, { orgId }, "release_operator")).secret;
      for (let i = 0; i < 50; i++) await ok(releaseTok, "register_challenge");
      const over = await call(releaseTok, "register_challenge", {});
      expect(!over.ok && over.error.code).toBe("conflict");
      expect((await call(other, "register_challenge", {})).ok).toBe(true);
      // The cap covers register challenges too: the other token's approve challenge path is its own.
      t += 11 * 60_000;
      expect((await call(releaseTok, "register_challenge", {})).ok).toBe(true);
      const rows = await db.run(async (h) =>
        h.orm.all<{ n: number }>(sql`select count(*) as n from approval_challenges`),
      );
      // Expired rows were purged: only the fresh ones remain.
      expect(Number(rows[0]!.n)).toBeLessThanOrEqual(2);
    });
  });
});

describe("keys without a forge login count for nothing (fix)", () => {
  test("not in approvals, not in the verifier, not in the quorum, and the overview says so", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    const keyless = await ed25519Approver("legacy", null);
    // A solo-style policy that lets authors approve would otherwise let a keyless key through.
    await setEnvPolicy(db, orgId, {
      environment: "production",
      required: 2,
      allowAuthorApproval: true,
      by: "t",
      now: t,
    });
    const o = await ok(releaseTok, "approvers_overview");
    expect(o.approvers.find((a: any) => a.person === "legacy").not_counting).toContain(
      "no forge login",
    );
    expect(o.approvers.find((a: any) => a.person === "alice").not_counting).toBeNull();
    // It cannot approve a run.
    const c = await challenge(keyless.id);
    const r = await approve(c.statement, await signOffline(keyless, c));
    expect(!r.ok && r.error.code).toBe("forbidden");
    // The quorum for a new key is over counted identities only: alice and bob, not the keyless key.
    const e = await ok(releaseTok, "request_enrolment", {
      person: "carl",
      forge_login: "carl-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(e.required).toBe(2);
    // It cannot sign an enrolment either.
    const ec = await ok(releaseTok, "enrolment_challenge", {
      enrolment_id: e.enrolment_id,
      approver: keyless.id,
    });
    const er = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
      statement: ec.statement,
      signature: await signOffline(keyless, ec),
    });
    expect(!er.ok && er.error.code).toBe("forbidden");
    // A stored approval from it (rows from before the rule) is not counted by the verifier.
    for (const p of [alice, bob]) {
      const cc = await challenge(p.id);
      expect((await approve(cc.statement, await signOffline(p, cc))).ok).toBe(true);
    }
    await db.run(async (h) => {
      await h.orm.run(sql`update approvers set forge_login = NULL where id = ${bob.id}`);
    });
    const v = await createApprovalVerifier(db, { rp: RP }).verify(
      { orgId, projectId: scope.projectId, runId, headSha: SHA, workflowHash: WF_HASH },
      "production",
      { now: t },
    );
    expect(v.approved).toBe(false);
  });

  test("request_enrolment audits the login the caller asserted", async () => {
    await ed25519Approver("alice", "alice-gh");
    await ok(releaseTok, "request_enrolment", {
      person: "dora",
      forge_login: "Dora-GH",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    const rows = await db.run(async (h) =>
      h.orm.all<{ d: string }>(
        sql`select input as d from audit_log where op = 'request_enrolment'`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.d).join(" ")).toContain("Dora-GH");
  });
});

// ---- the per-org key policy (#152) ----

describe("approval key policy", () => {
  const snake2 = (r: { clientDataJSON: string; attestationObject: string }) => ({
    client_data_json: r.clientDataJSON,
    attestation_object: r.attestationObject,
  });
  type RegOpts = Parameters<Soft["register"]>[1];
  async function enrolPasskey(person: string, o?: RegOpts) {
    const dev = softAuthenticator();
    const ch = await ok(releaseTok, "register_challenge");
    const r = await call(releaseTok, "request_enrolment", {
      person,
      forge_login: `${person}-gh`,
      webauthn: { challenge: ch.challenge, ...snake2(dev.register(ch.challenge, o)) },
    });
    return { dev, r };
  }
  async function quorumEnrol(enrolmentId: string, signers: Person[]) {
    for (const p of signers) {
      const c = await ok(releaseTok, "enrolment_challenge", {
        enrolment_id: enrolmentId,
        approver: p.id,
      });
      const r = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
        statement: c.statement,
        signature: await signOffline(p, c),
      });
      if (!r.ok) throw new Error(`approve_enrolment: ${r.error.message}`);
    }
  }
  const packedA = () => ({ packed: { aaguid: AAGUID_A, leaf: deviceCert(AAGUID_A) } });
  const HW = { mode: "hardware", aaguids: [aaguidText(AAGUID_A)] };

  type Signer = { id: string; sign: (c: any) => Promise<unknown> };
  const offline = (p: Person): Signer => ({ id: p.id, sign: (c) => signOffline(p, c) });
  const passkeyOf = (id: string, dev: Soft): Signer => ({
    id,
    sign: async (c) => ({ kind: "webauthn", ...dev.assert(c.challenge) }),
  });

  /** The challenge for a policy change, to be signed by `signer`. */
  const policyChallenge = (input: unknown, approver: string) =>
    call(releaseTok, "key_policy_challenge", { ...(input as object), approver });
  /** Every signer signs the same proposal; returns the last approve_key_policy result. */
  async function changePolicy(input: unknown, signers: Signer[]) {
    let last: Awaited<ReturnType<typeof dispatch>> | undefined;
    for (const sg of signers) {
      const c = await policyChallenge(input, sg.id);
      if (!c.ok) return c;
      last = await dispatch(env, { kind: "signed" }, "approve_key_policy", {
        statement: (c.output as any).statement,
        signature: await sg.sign(c.output),
      });
      if (!last.ok) return last;
    }
    return last!;
  }

  /**
   * alice and bob (offline keys) plus carol and dave, attested devices with AAGUID A, all under
   * `any`. Two attested people, so the hardware policy leaves the quorum of 2 intact.
   */
  async function world() {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    const devs: Record<string, Soft> = {};
    for (const name of ["carol", "dave"]) {
      const { dev, r } = await enrolPasskey(name, packedA());
      if (!r.ok) throw new Error(r.error.message);
      await quorumEnrol((r.output as any).enrolment_id, [alice, bob]);
      devs[name] = dev;
    }
    const ov = await ok(releaseTok, "approvers_overview");
    const carol = ov.approvers.find((a: any) => a.person === "carol");
    const dave = ov.approvers.find((a: any) => a.person === "dave");
    return { alice, bob, carol, dave, devs };
  }

  test("an attested key is accepted and recorded; the policy defaults to any", async () => {
    const { carol } = await world();
    expect(carol).toMatchObject({ attested: true, aaguid: aaguidText(AAGUID_A) });
    const o = await ok(releaseTok, "approvers_overview");
    expect(o.key_policy).toEqual({ mode: "any", presets: [], aaguids: [] });
    expect(o.approvers.every((a: any) => a.not_counting === null)).toBe(true);
  });

  test("no token can set the policy; it takes a quorum-signed statement, and the one-signer case is not enough", async () => {
    const { alice, bob } = await world();
    // There is no token operation that sets it, and the server CLI refuses once approvers exist.
    expect(registry.ops.map((o) => o.name)).not.toContain("set_approval_key_policy");
    expect(
      (await call(releaseTok, "approve_key_policy", { statement: {}, signature: {} })).ok,
    ).toBe(false);
    // The challenge alone changes nothing.
    const c = await policyChallenge(HW, alice.id);
    expect(c.ok).toBe(true);
    expect((await ok(releaseTok, "approvers_overview")).key_policy.mode).toBe("any");
    // One signature of the two required: not applied. The second applies it.
    const first = await changePolicy(HW, [offline(alice)]);
    expect(first.ok && first.output).toMatchObject({ approvals: 1, required: 2, applied: false });
    expect((await ok(releaseTok, "approvers_overview")).key_policy.mode).toBe("any");
    const second = await changePolicy(HW, [offline(bob)]);
    expect(second.ok && second.output).toMatchObject({ approvals: 2, required: 2, applied: true });
    expect((await ok(releaseTok, "approvers_overview")).key_policy.mode).toBe("hardware");
  });

  test("the quorum is computed before the change: signers must count under the policy being replaced", async () => {
    const { alice, bob, carol, dave, devs } = await world();
    const cs = passkeyOf(carol.id, devs.carol!);
    const ds = passkeyOf(dave.id, devs.dave!);
    expect((await changePolicy(HW, [offline(alice), offline(bob)])).ok).toBe(true);
    // Now alice and bob no longer count: they cannot sign a loosening.
    const refused = await changePolicy({ mode: "any" }, [offline(alice)]);
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    // carol alone is one of two: not applied. carol and dave: applied, with the quorum of two
    // that was in force before the change (not lowered by the smaller counted set).
    const one = await changePolicy({ mode: "any" }, [cs]);
    expect(one.ok && one.output).toMatchObject({ approvals: 1, required: 2, applied: false });
    const two = await changePolicy({ mode: "any" }, [ds]);
    expect(two.ok && two.output).toMatchObject({ approvals: 2, required: 2, applied: true });
  });

  test("a change that would leave fewer counted people than the quorum is refused", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    const carolEnrol = await enrolPasskey("carol", packedA());
    if (!carolEnrol.r.ok) throw new Error(carolEnrol.r.error.message);
    await quorumEnrol((carolEnrol.r.output as any).enrolment_id, [alice, bob]);
    // Only carol would count under hardware: one person, quorum is two.
    const r = await policyChallenge(HW, alice.id);
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toContain("fewer than the 2");
    // And with nobody who would satisfy it at all.
    const none = await policyChallenge(
      { mode: "hardware", aaguids: [aaguidText(AAGUID_B)] },
      alice.id,
    );
    expect(!none.ok && none.error.code).toBe("conflict");
    expect(!(await policyChallenge({ mode: "hardware" }, alice.id)).ok).toBe(true);
    expect(!(await policyChallenge({ mode: "hardware", presets: ["nope"] }, alice.id)).ok).toBe(
      true,
    );
    expect(
      !(await policyChallenge({ mode: "hardware", aaguids: ["not-a-uuid"] }, alice.id)).ok,
    ).toBe(true);
  });

  test("a statement is for the policy it was issued against: after it moves on, it is refused", async () => {
    const { alice, bob } = await world();
    const stale = await policyChallenge(HW, alice.id);
    if (!stale.ok) throw new Error(stale.error.message);
    expect((await changePolicy(HW, [offline(alice), offline(bob)])).ok).toBe(true);
    const replay = await dispatch(env, { kind: "signed" }, "approve_key_policy", {
      statement: (stale.output as any).statement,
      signature: await signOffline(alice, stale.output as any),
    });
    expect(!replay.ok).toBe(true);
  });

  test("approval records cannot be replayed across policy versions: a statement names the policy generation", async () => {
    const { alice, bob, carol, dave, devs } = await world();
    const cs = passkeyOf(carol.id, devs.carol!);
    const ds = passkeyOf(dave.id, devs.dave!);
    // P1 (any to hardware) at generation 0: alice signs it, one of two.
    const p1 = await policyChallenge(HW, alice.id);
    if (!p1.ok) throw new Error(p1.error.message);
    expect(
      (
        await dispatch(env, { kind: "signed" }, "approve_key_policy", {
          statement: (p1.output as any).statement,
          signature: await signOffline(alice, p1.output as any),
        })
      ).ok,
    ).toBe(true);
    const p1b = await policyChallenge(HW, bob.id);
    if (!p1b.ok) throw new Error(p1b.error.message);
    // The policy moves on twice and ends up where P1 started (any): same old policy, new generation.
    const other = { mode: "hardware", presets: ["yubikey"], aaguids: [aaguidText(AAGUID_A)] };
    expect((await changePolicy(other, [offline(alice), offline(bob)])).ok).toBe(true);
    expect((await changePolicy({ mode: "any" }, [cs, ds])).ok).toBe(true);
    // Replaying P1 now (old = any again) is refused: it was issued against generation 0.
    const replay = await dispatch(env, { kind: "signed" }, "approve_key_policy", {
      statement: (p1b.output as any).statement,
      signature: await signOffline(bob, p1b.output as any),
    });
    expect(!replay.ok && replay.error.code).toBe("conflict");
    expect(!replay.ok && replay.error.message).toContain("policy changed");
    const c1 = await policyChallenge(HW, bob.id);
    if (!c1.ok) throw new Error(c1.error.message);
    expect((c1.output as any).statement.generation).toBe(2);
    // And alice's old signature counts for nothing toward a fresh proposal: only bob's counts.
    const r = await dispatch(env, { kind: "signed" }, "approve_key_policy", {
      statement: (c1.output as any).statement,
      signature: await signOffline(bob, c1.output as any),
    });
    expect(r.ok && r.output).toMatchObject({ approvals: 1, required: 2, applied: false });
  });

  test("under hardware: none attestation, an unlisted AAGUID, an offline key and a bad statement are refused; an allowlisted attested key is accepted", async () => {
    const { alice, bob } = await world();
    expect((await changePolicy(HW, [offline(alice), offline(bob)])).ok).toBe(true);
    expect((await ok(releaseTok, "register_challenge")).attestation).toBe("direct");

    const none = await enrolPasskey("erin");
    expect(!none.r.ok && none.r.error.message).toContain("no verified hardware attestation");
    const other = await enrolPasskey("erin", {
      packed: { aaguid: AAGUID_B, leaf: deviceCert(AAGUID_B) },
    });
    expect(!other.r.ok && other.r.error.message).toContain("AAGUID is not on the allowlist");
    const offlineKey = await call(releaseTok, "request_enrolment", {
      person: "erin",
      forge_login: "erin-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(!offlineKey.ok && offlineKey.error.code).toBe("invalid_input");
    // A device whose cert does not chain to a pinned root is unverified.
    const rogueRoot = makeCert({ cn: "Rogue Root", ca: true });
    const rogue = makeCert({
      cn: "Rogue Device",
      issuer: { cn: "Rogue Root", key: rogueRoot.key },
      ca: false,
      aaguid: AAGUID_A,
    });
    const untrusted = await enrolPasskey("erin", { packed: { aaguid: AAGUID_A, leaf: rogue } });
    expect(!untrusted.r.ok && untrusted.r.error.message).toContain("no verified hardware");
    // A leaf without the AAGUID extension binds nothing: not verified, never allowlisted.
    const noExt = makeCert({
      cn: "No Ext",
      issuer: { cn: "Test Vendor Root", key: TEST_ROOT.key },
      ca: false,
    });
    const unbound = await enrolPasskey("erin", { packed: { aaguid: AAGUID_A, leaf: noExt } });
    expect(!unbound.r.ok && unbound.r.error.message).toContain("no verified hardware");
    // A tampered attestation signature is refused outright.
    const tampered = await enrolPasskey("erin", {
      packed: { ...packedA().packed, tamper: true },
    });
    expect(!tampered.r.ok && tampered.r.error.message).toContain("does not verify");
    // A device certificate that names a different AAGUID than the credential is refused.
    const mismatch = await enrolPasskey("erin", {
      packed: { aaguid: AAGUID_A, leaf: deviceCert(AAGUID_B) },
    });
    expect(!mismatch.r.ok && mismatch.r.error.message).toContain("AAGUID");

    expect((await enrolPasskey("erin", packedA())).r.ok).toBe(true);
  });

  test("flipping to hardware makes keys that do not satisfy it stop counting, at once", async () => {
    const { alice, bob, carol, dave, devs } = await world();
    const verifier = createApprovalVerifier(db, { rp: RP });
    const subject = {
      orgId,
      projectId: scope.projectId,
      runId,
      headSha: SHA,
      workflowHash: WF_HASH,
    };
    for (const p of [alice, bob]) {
      const c = await challenge(p.id);
      expect((await approve(c.statement, await signOffline(p, c))).ok).toBe(true);
    }
    expect((await verifier.verify(subject, "production", { now: t })).approved).toBe(true);

    expect((await changePolicy(HW, [offline(alice), offline(bob)])).ok).toBe(true);
    const after = await verifier.verify(subject, "production", { now: t });
    expect(!after.approved && after.have).toBe(0);
    const run2 = await makeRun({ sha: "d".repeat(40) });
    const c = await challenge(alice.id, "production", run2);
    const refused = await approve(c.statement, await signOffline(alice, c));
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    const o = await ok(releaseTok, "approvers_overview");
    expect(o.approvers.find((a: any) => a.person === "alice").not_counting).toContain(
      "offline key",
    );
    expect(o.approvers.find((a: any) => a.person === "carol").not_counting).toBeNull();
    // carol's and dave's attested passkeys approve and count as two.
    for (const [who, dev] of [
      [carol, devs.carol!],
      [dave, devs.dave!],
    ] as const) {
      const cc = await challenge(who.id, "production", run2);
      const r = await approve(cc.statement, { kind: "webauthn", ...dev.assert(cc.challenge) });
      expect(r.ok).toBe(true);
    }
    // Loosening back to any (signed by carol and dave) restores the old keys.
    expect(
      (
        await changePolicy({ mode: "any" }, [
          passkeyOf(carol.id, devs.carol!),
          passkeyOf(dave.id, devs.dave!),
        ])
      ).ok,
    ).toBe(true);
    expect((await verifier.verify(subject, "production", { now: t })).approved).toBe(true);
  });

  test("the enrolment quorum only counts keys that satisfy the policy", async () => {
    const { alice, bob, carol } = await world();
    expect((await changePolicy(HW, [offline(alice), offline(bob)])).ok).toBe(true);
    const e = await enrolPasskey("erin", packedA());
    if (!e.r.ok) throw new Error(e.r.error.message);
    expect((e.r.output as any).required).toBe(2);
    // alice's offline key cannot sign an enrolment under hardware.
    const c = await ok(releaseTok, "enrolment_challenge", {
      enrolment_id: (e.r.output as any).enrolment_id,
      approver: alice.id,
    });
    const r = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
      statement: c.statement,
      signature: await signOffline(alice, c),
    });
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(carol).toBeDefined();
  });

  test("the AAGUID preset expands to the YubiKey list and custom AAGUIDs are normalised", async () => {
    const { alice, bob } = await world();
    const r = await changePolicy(
      { mode: "hardware", presets: ["yubikey"], aaguids: [aaguidText(AAGUID_A).toUpperCase()] },
      [offline(alice), offline(bob)],
    );
    expect(r.ok && (r.output as any).policy.aaguids).toEqual([aaguidText(AAGUID_A)]);
    expect(r.ok && (r.output as any).policy.presets).toEqual(["yubikey"]);
    const { allowedAaguids } = await import("../src/approvals/key-policy");
    const set = allowedAaguids((r as any).output.policy);
    expect(set.has("cb69481e-8ff7-4039-93ec-0a2729a154a8")).toBe(true);
    expect(set.has(aaguidText(AAGUID_A))).toBe(true);
  });
});

describe("quorum counting and self-approval hardening", () => {
  test("a revoked approver's earlier signature no longer counts toward a quorum", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    const bob = await ed25519Approver("bob", "bob-gh");
    await ed25519Approver("cleo", "cleo-gh");
    const e = await ok(releaseTok, "request_enrolment", {
      person: "dora",
      forge_login: "dora-gh",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(e.required).toBe(2);
    const sign = async (p: Person) => {
      const c = await ok(releaseTok, "enrolment_challenge", {
        enrolment_id: e.enrolment_id,
        approver: p.id,
      });
      return dispatch(env, { kind: "signed" }, "approve_enrolment", {
        statement: c.statement,
        signature: await signOffline(p, c),
      });
    };
    const first = await sign(alice);
    expect(first.ok && first.output).toMatchObject({ approvals: 1, activated: false });
    // alice is revoked: her signature stays on record but is worth nothing.
    await db.run(async (h) => {
      await h.orm.run(sql`update approvers set revoked_at = ${t} where id = ${alice.id}`);
    });
    const second = await sign(bob);
    expect(second.ok && second.output).toMatchObject({ approvals: 1, activated: false });
    // The overview agrees.
    const ov = await ok(releaseTok, "approvers_overview");
    expect(ov.pending_enrolments[0].approvals).toBe(1);
  });

  test("an enrolee cannot approve their own key by picking a new forge login", async () => {
    const alice = await ed25519Approver("alice", "alice-gh");
    await ed25519Approver("bob", "bob-gh");
    // Taking a new login under an existing person's name is refused when enrolling.
    const r = await call(releaseTok, "request_enrolment", {
      person: "Alice",
      forge_login: "alice-other",
      ed25519_public_key: generateEd25519().publicSpki,
    });
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(!r.ok && r.error.message).toContain("under a different forge login");
    // Even if such a row exists (written before the rule), alice's key cannot approve it.
    const k = generateEd25519();
    const row = await db.transaction(async (tx) =>
      tx.run(async (h) => {
        const id = "enrol-self";
        await h.orm.run(
          sql`insert into approver_enrolments (id, org_id, person, forge_login, kind, public_key, alg, sign_count, requested_by, created_at, expires_at, aaguid, attested) values (${id}, ${orgId}, 'alice', 'alice-other', 'ed25519', ${k.publicSpki}, 'EdDSA', 0, 'test', ${t}, ${t + 86_400_000}, null, 0)`,
        );
        return id;
      }),
    );
    const c = await ok(releaseTok, "enrolment_challenge", {
      enrolment_id: row,
      approver: alice.id,
    });
    const self = await dispatch(env, { kind: "signed" }, "approve_enrolment", {
      statement: c.statement,
      signature: await signOffline(alice, c),
    });
    expect(!self.ok && self.error.code).toBe("forbidden");
    expect(!self.ok && self.error.message).toContain("their own key");
  });
});
