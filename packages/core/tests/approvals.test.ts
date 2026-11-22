import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  listJobs,
  openDatabase,
  setEnvPolicy,
  type Scope,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { createRestApi } from "../src/ops/rest";
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
  map: (pairs: [Buffer, Buffer][]) => Buffer.concat([cborHead(5, pairs.length), ...pairs.flat()]),
};

type Soft = {
  credentialId: Buffer;
  register(
    challenge: string,
    o?: Partial<{ origin: string; rpId: string; uv: boolean }>,
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
  env = { registry, db, now, webauthn: RP };
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
    expect(!r.ok && r.error.message).toContain("cannot establish");
    // A run whose author is unknown.
    const anon = await makeRun({ sha: "9".repeat(40) });
    await db.run(async (h) => {
      await h.orm.run(sql`update runs set actor = NULL where id = ${anon}`);
    });
    const bob = await ed25519Approver("bob");
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
    const c3 = await challenge(noLogin.id);
    expect((await approve(c3.statement, await signOffline(noLogin, c3))).ok).toBe(true);
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
    // The run's author becomes unknown after the fact: the approvals stop counting.
    await db.run(async (h) => {
      await h.orm.run(sql`update runs set actor = NULL where id = ${runId}`);
    });
    const v = await verifier.verify(subject, "production", { now: t });
    expect(!v.approved && v.reason).toBe("self_approval");
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
});
