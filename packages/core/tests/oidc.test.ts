import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { resetFailureThrottle } from "../src/audit/failures";
import {
  chainedAudit,
  clearFreeze,
  createAttempt,
  getSecretRecord,
  setFreeze,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { mintAttemptCredential, verifyAttemptCredential } from "../src/oidc/attempt-credential";
import { oidcCommand } from "../src/oidc/cli";
import { createOidcHandler, type OidcHandler } from "../src/oidc/http";
import {
  NBF_LEEWAY_SECONDS,
  OidcIssuer,
  parseAllowClasses,
  validAudience,
} from "../src/oidc/issuer";
import { PUBLIC_JWK_MEMBERS, RETIRED_GRACE_MS, MAX_TOKEN_SECONDS } from "../src/oidc/keys";
import {
  initMasterKey,
  loadMasterKey,
  open,
  secretAad,
  SecretDecryptError,
} from "../src/secrets/crypto";
import { seedWorld, type Tenant } from "./ops-helpers";

const BASE = "https://ci.example.com/oidc";
let db: Db;
let a: Tenant;
let b: Tenant;
let master: Buffer;
let issuer: OidcIssuer;
let handler: OidcHandler;
let now = 1_800_000_000_000;

const make = (allowClasses?: string[]) => {
  issuer = new OidcIssuer({
    db,
    masterKey: master,
    baseUrl: BASE,
    now: () => now,
    ...(allowClasses ? { allowClasses } : {}),
  });
  handler = createOidcHandler({ db, issuer, masterKey: master, now: () => now });
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  master = randomBytes(32);
  now = 1_800_000_000_000;
  resetFailureThrottle();
  make();
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/web", actor: "octo", ref: "refs/heads/main", event: "push" })
    .where(eq(s.runs.id, a.runId));
  await start(a, "protected");
});

const start = (t: Tenant, klass: string | null, state = "running") =>
  db.orm
    .update(s.jobAttempts)
    .set({ state, trustClass: klass })
    .where(eq(s.jobAttempts.id, t.attemptId));

const cred = (t: Tenant, ttl?: number) =>
  mintAttemptCredential(master, { orgId: t.orgId, attemptId: t.attemptId }, now, ttl);
const get = (path: string, token?: string, method = "GET", body?: unknown) =>
  handler.handle(
    new Request(`https://ci.example.com${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );

/** What a relying party does: fetch the JWKS, pick the key by kid, verify ES256, check the window. */
async function relyingParty(token: string, slug: string, aud: string) {
  const [h, p, sig] = token.split(".") as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const jwks = (await (await get(`/oidc/${slug}/jwks.json`))!.json()) as {
    keys: Record<string, string>[];
  };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false as const, why: "no such kid", header, claims };
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64url"),
  );
  const t = Math.floor(now / 1000);
  const fine =
    ok &&
    header.alg === "ES256" &&
    claims.aud === aud &&
    claims.iss === `${BASE}/${slug}` &&
    t >= claims.nbf &&
    t < claims.exp;
  return { ok: fine, why: ok ? "claims" : "signature", header, claims };
}

const mint = async (t: Tenant, aud = "sts.amazonaws.com") => {
  const res = (await get(
    `/oidc/${t === a ? "org-a" : "org-b"}/token?audience=${encodeURIComponent(aud)}`,
    cred(t),
  ))!;
  return {
    res,
    body: (await res.json()) as { value?: string; expires_at?: number; error?: string },
  };
};

describe("discovery and JWKS", () => {
  test("discovery points at this org's own issuer and JWKS", async () => {
    const d = (await (await get("/oidc/org-a/.well-known/openid-configuration"))!.json()) as Record<
      string,
      unknown
    >;
    expect(d.issuer).toBe(`${BASE}/org-a`);
    expect(d.jwks_uri).toBe(`${BASE}/org-a/jwks.json`);
    expect(d.id_token_signing_alg_values_supported).toEqual(["ES256"]);
    expect(d.subject_types_supported).toEqual(["public"]);
    expect(d.response_types_supported).toEqual(["id_token"]);
  });

  test("the JWKS carries public members only, never private parameters", async () => {
    const res = (await get("/oidc/org-a/jwks.json"))!;
    const text = await res.text();
    const jwks = JSON.parse(text) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.length).toBe(1);
    for (const k of jwks.keys) {
      expect(Object.keys(k).toSorted()).toEqual([...PUBLIC_JWK_MEMBERS].toSorted());
      expect(k).toMatchObject({ kty: "EC", crv: "P-256", use: "sig", alg: "ES256" });
    }
    for (const bad of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"', '"k"', "PRIVATE"]) {
      expect(text).not.toContain(bad);
    }
    expect(res.headers.get("cache-control")).toContain("max-age");
  });

  test("unknown orgs and the system org are 404, other methods 405", async () => {
    expect((await get("/oidc/nope/jwks.json"))!.status).toBe(404);
    expect((await get("/oidc/_system/jwks.json"))!.status).toBe(404);
    expect((await get("/oidc/org-a/jwks.json", undefined, "POST"))!.status).toBe(405);
    expect(await get("/healthz")).toBeUndefined();
  });

  test("each org has its own keys; a token of one does not verify under the other's JWKS", async () => {
    await start(b, "protected");
    const ta = (await mint(a)).body.value!;
    const jb = (await (await get("/oidc/org-b/jwks.json"))!.json()) as { keys: { kid: string }[] };
    const ja = (await (await get("/oidc/org-a/jwks.json"))!.json()) as { keys: { kid: string }[] };
    expect(ja.keys[0]!.kid).not.toBe(jb.keys[0]!.kid);
    expect((await relyingParty(ta, "org-a", "sts.amazonaws.com")).ok).toBe(true);
    expect((await relyingParty(ta, "org-b", "sts.amazonaws.com")).ok).toBe(false);
  });

  test("the private key is sealed in the oidc domain, by kid, and the kid is the key's thumbprint", async () => {
    const { keys } = (await (await get("/oidc/org-a/jwks.json"))!.json()) as {
      keys: { kid: string }[];
    };
    const name = `oidc/key/${keys[0]!.kid}`;
    const sealed = (await getSecretRecord(db, { orgId: a.orgId }, name))!;
    expect(sealed).not.toContain("PRIVATE");
    expect(() => open(master, sealed, secretAad(a.orgId, name), "system")).toThrow(
      SecretDecryptError,
    );
    expect(() => open(master, sealed, secretAad(a.orgId, name), "job")).toThrow(SecretDecryptError);
    expect(JSON.parse(open(master, sealed, secretAad(a.orgId, name), "oidc", a.orgId)).kid).toBe(
      keys[0]!.kid,
    );
    expect(keys[0]!.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("minting", () => {
  test("a run with no known actor (a tag run has none) gets a token with NO actor claim", async () => {
    await db.orm.update(s.runs).set({ actor: null }).where(eq(s.runs.id, a.runId));
    const { res, body } = await mint(a);
    expect(res.status).toBe(200);
    const rp = await relyingParty(body.value!, "org-a", "sts.amazonaws.com");
    expect(rp).toMatchObject({ ok: true });
    expect(Object.hasOwn(rp.claims, "actor")).toBe(false);
    expect(rp.claims).toMatchObject({ event_name: "push", trust_class: "protected" });
  });

  test("a protected attempt gets a verifiable token with the documented claims", async () => {
    const { res, body } = await mint(a);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rp = await relyingParty(body.value!, "org-a", "sts.amazonaws.com");
    expect(rp).toMatchObject({ ok: true });
    const c = rp.claims;
    const iat = Math.floor(now / 1000);
    expect(c).toMatchObject({
      iss: `${BASE}/org-a`,
      aud: "sts.amazonaws.com",
      sub: "org:org-a:project:app:repo:acme/web:ref:refs/heads/main:class:protected:env:none",
      iat,
      nbf: iat - NBF_LEEWAY_SECONDS,
      org: "org-a",
      org_id: a.orgId,
      project: "app",
      project_id: a.projectId,
      repository: "acme/web",
      repository_owner: "acme",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      workflow_ref: "acme/web/.github/workflows/ci.yml@refs/heads/main",
      job: "build",
      run_id: a.runId,
      job_id: a.jobId,
      attempt_id: a.attemptId,
      run_attempt: 1,
      rerun: false,
      trust_class: "protected",
      event_name: "push",
      actor: "octo",
      environment: null,
    });
    expect(c.exp - c.iat).toBeLessThanOrEqual(MAX_TOKEN_SECONDS);
    expect(c.exp - c.iat).toBeGreaterThan(0);
    expect(body.expires_at).toBe(c.exp * 1000);
    expect(c.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("every mint has its own jti; the audience is whatever was asked", async () => {
    const t1 = (await mint(a, "aud-one")).body.value!;
    const t2 = (await mint(a, "aud-two")).body.value!;
    const r1 = await relyingParty(t1, "org-a", "aud-one");
    const r2 = await relyingParty(t2, "org-a", "aud-two");
    expect(r1.ok && r2.ok).toBe(true);
    expect(r1.claims.jti).not.toBe(r2.claims.jti);
    expect((await relyingParty(t1, "org-a", "aud-two")).ok).toBe(false);
  });

  test("a tampered token or signature does not verify", async () => {
    const t = (await mint(a)).body.value!;
    const [h, p, sig] = t.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, trust_class: "release" })).toString("base64url")}.${sig}`;
    expect((await relyingParty(forged, "org-a", "sts.amazonaws.com")).why).toBe("signature");
    const flipped = `${h}.${p}.${Buffer.from(Buffer.from(sig, "base64url").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64url")}`;
    expect((await relyingParty(flipped, "org-a", "sts.amazonaws.com")).ok).toBe(false);
  });

  test("claims reflect each class; the sub changes with it", async () => {
    make(["protected", "release", "trusted_pr"]);
    for (const klass of ["protected", "release", "trusted_pr"]) {
      await start(a, klass);
      const rp = await relyingParty((await mint(a)).body.value!, "org-a", "sts.amazonaws.com");
      expect(rp.ok).toBe(true);
      expect(rp.claims.trust_class).toBe(klass);
      expect(rp.claims.sub).toContain(`:class:${klass}:`);
    }
  });

  test("untrusted_pr and trusted_pr get nothing by default; unrecorded is refused", async () => {
    for (const klass of ["untrusted_pr", "trusted_pr"]) {
      await start(a, klass);
      const { res, body } = await mint(a);
      expect(res.status).toBe(403);
      expect(body).toEqual({ error: "class_not_allowed" });
    }
    await start(a, null);
    expect((await mint(a)).body.error).toBe("class_unrecorded");
  });

  test("an operator can widen the allow list, and unknown names are refused", async () => {
    make(parseAllowClasses("protected,release,untrusted_pr"));
    await start(a, "untrusted_pr");
    expect((await mint(a)).res.status).toBe(200);
    expect(() => parseAllowClasses("protected,bogus")).toThrow();
    expect(parseAllowClasses(undefined)).toEqual(["protected", "release"]);
  });

  test("the attempt must be running", async () => {
    await start(a, "protected", "success");
    expect((await mint(a)).body.error).toBe("attempt_not_running");
    await start(a, "protected", "queued");
    expect((await mint(a)).body.error).toBe("attempt_not_running");
  });

  test("the audience is mandatory, one string, printable and bounded", async () => {
    for (const bad of ["", "has space", "x".repeat(257), "tab\there"]) {
      expect(validAudience(bad)).toBe(false);
      const res = (await get(`/oidc/org-a/token?audience=${encodeURIComponent(bad)}`, cred(a)))!;
      expect(res.status).toBe(400);
    }
    expect((await get("/oidc/org-a/token", cred(a)))!.status).toBe(400);
    const post = (await get("/oidc/org-a/token", cred(a), "POST", { audience: ["a", "b"] }))!;
    expect(post.status).toBe(400);
    const okPost = (await get("/oidc/org-a/token", cred(a), "POST", {
      audience: "https://vault.example.com",
    }))!;
    expect(okPost.status).toBe(200);
  });

  test("values the forge controls cannot forge another sub segment", async () => {
    await db.orm
      .update(s.runs)
      .set({ ref: "refs/heads/x:class:protected:env:prod", repo: null })
      .where(eq(s.runs.id, a.runId));
    const rp = await relyingParty((await mint(a)).body.value!, "org-a", "sts.amazonaws.com");
    const sub = rp.claims.sub as string;
    expect(sub).toContain("repo:none");
    expect(sub).toContain("x%3Aclass%3Aprotected%3Aenv%3Aprod");
    expect(sub.split(":").length).toBe(12); // six key:value pairs, no more
  });
});

describe("the attempt credential", () => {
  test("bearer required; wrong, expired, tampered or other-org credentials are refused", async () => {
    expect((await get("/oidc/org-a/token?audience=x"))!.status).toBe(401);
    expect((await get("/oidc/org-a/token?audience=x", "lsat1.garbage.garbage"))!.status).toBe(401);
    const good = cred(a);
    expect((await get("/oidc/org-a/token?audience=x", good))!.status).toBe(200);
    // expired
    const short = mintAttemptCredential(
      master,
      { orgId: a.orgId, attemptId: a.attemptId },
      now - 10_000,
      1000,
    );
    expect((await get("/oidc/org-a/token?audience=x", short))!.status).toBe(401);
    // tampered: another attempt id under the same signature
    const [pfx, body, sig] = good.split(".") as [string, string, string];
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), a: "other" }),
    ).toString("base64url");
    expect((await get("/oidc/org-a/token?audience=x", `${pfx}.${forgedBody}.${sig}`))!.status).toBe(
      401,
    );
    // another master key
    const alien = mintAttemptCredential(
      randomBytes(32),
      { orgId: a.orgId, attemptId: a.attemptId },
      now,
    );
    expect((await get("/oidc/org-a/token?audience=x", alien))!.status).toBe(401);
    // org A's credential at org B's issuer URL
    expect((await get("/oidc/org-b/token?audience=x", good))!.status).toBe(403);
    expect(verifyAttemptCredential(master, good, now)).toEqual({
      orgId: a.orgId,
      attemptId: a.attemptId,
    });
    expect(verifyAttemptCredential(master, good, now + 25 * 3600_000)).toBeUndefined();
  });

  test("an attempt that is not running gets nothing even with a live credential", async () => {
    const c = cred(a);
    await start(a, "protected", "failure");
    expect((await get("/oidc/org-a/token?audience=x", c))!.status).toBe(403);
  });
});

describe("rotation", () => {
  test("the old key stays published until its last token has expired, then goes", async () => {
    const old = (await mint(a)).body.value!;
    const oldKid = (await relyingParty(old, "org-a", "sts.amazonaws.com")).header.kid as string;
    const rotatedAt = now + 1000;
    now = rotatedAt;
    const r = await issuer.keys.rotate(a.orgId, now);
    expect(r.retired).toEqual([oldKid]);
    const kids = async () =>
      (
        (await (await get("/oidc/org-a/jwks.json"))!.json()) as { keys: { kid: string }[] }
      ).keys.map((k) => k.kid);
    expect((await kids()).toSorted()).toEqual([oldKid, r.kid].toSorted());
    // the token signed before the rotation still verifies; a new one uses the new key
    expect((await relyingParty(old, "org-a", "sts.amazonaws.com")).ok).toBe(true);
    const fresh = (await mint(a)).body.value!;
    expect((await relyingParty(fresh, "org-a", "sts.amazonaws.com")).header.kid).toBe(r.kid);
    // still inside the window (every token the old key signed has expired by then)
    now = rotatedAt + MAX_TOKEN_SECONDS * 1000 + RETIRED_GRACE_MS - 1;
    expect(await kids()).toContain(oldKid);
    // past it: gone from the JWKS and deleted
    now = rotatedAt + MAX_TOKEN_SECONDS * 1000 + RETIRED_GRACE_MS;
    expect(await kids()).toEqual([r.kid]);
    expect(await issuer.keys.purge(a.orgId, now)).toEqual([oldKid]);
    expect(await getSecretRecord(db, { orgId: a.orgId }, `oidc/key/${oldKid}`)).toBeUndefined();
    expect((await relyingParty(old, "org-a", "sts.amazonaws.com")).ok).toBe(false);
  });

  test("two rotations in a row keep both retired keys inside their windows", async () => {
    const k0 = (await issuer.keys.published(a.orgId, now))[0]!.kid;
    now += 1000;
    const k1 = (await issuer.keys.rotate(a.orgId, now)).kid;
    now += 1000;
    const k2 = (await issuer.keys.rotate(a.orgId, now)).kid;
    expect((await issuer.keys.published(a.orgId, now)).map((k) => k.kid).toSorted()).toEqual(
      [k0, k1, k2].toSorted(),
    );
  });

  test("key creation and rotation are audited by kid, never by key", async () => {
    await mint(a);
    await issuer.keys.rotate(a.orgId, now);
    const rows = (await chainedAudit(db, a.orgId, 0, 100)).filter((r) =>
      r.op.startsWith("oidc_key"),
    );
    expect(rows.map((r) => r.op)).toEqual(["oidc_key_create", "oidc_key_rotate"]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });
});

describe("audit", () => {
  test("every mint is audited with what was minted, never the token", async () => {
    const { body } = await mint(a, "audience-1");
    const row = (await chainedAudit(db, a.orgId, 0, 100)).find((r) => r.op === "oidc_mint")!;
    expect(row.outcome).toBe("ok");
    expect(JSON.parse(row.input)).toMatchObject({
      aud: "audience-1",
      run: a.runId,
      job: a.jobId,
      attempt: a.attemptId,
      class: "protected",
    });
    expect(row.input).not.toContain(body.value!);
    expect(JSON.parse(row.input).jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("refusals are audited too", async () => {
    await start(a, "untrusted_pr");
    await mint(a);
    const row = (await chainedAudit(db, a.orgId, 0, 100)).find((r) => r.op === "oidc_mint")!;
    expect(row.outcome).toBe("error:class_not_allowed");
  });
});

describe("incident freeze, reruns and clock skew", () => {
  const freezeNow = () => ({ reason: "key leaked", by: "tester", now });

  test("an org freeze stops minting, and the refusal is audited", async () => {
    expect((await mint(a)).res.status).toBe(200);
    await setFreeze(db, { orgId: a.orgId }, freezeNow());
    const r = await mint(a);
    expect(r.res.status).toBe(403);
    expect(r.body.error).toBe("frozen");
    const rows = await chainedAudit(db, a.orgId, 0, 100);
    expect(rows.filter((x) => x.op === "oidc_mint").at(-1)!.outcome).toBe("error:frozen");
    // Unfreezing lets the same credential mint again.
    await clearFreeze(db, { orgId: a.orgId });
    expect((await mint(a)).res.status).toBe(200);
  });

  test("a project freeze stops its attempts only", async () => {
    await setFreeze(db, { orgId: a.orgId, projectId: a.projectId }, freezeNow());
    expect((await mint(a)).body.error).toBe("frozen");
    await clearFreeze(db, { orgId: a.orgId, projectId: a.projectId });
    expect((await mint(a)).res.status).toBe(200);
  });

  test("a rerun is its own attempt: a distinct attempt_id, a higher run_attempt, rerun true", async () => {
    const first = (await mint(a)).body as { value: string };
    const again = (await createAttempt(db, a.scope, {
      jobId: a.jobId,
      provider: "test",
      rerunReason: "flaky",
    }))!;
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, again.id));
    const res = (await get(
      `/oidc/${a.slug}/token?audience=sts`,
      mintAttemptCredential(master, { orgId: a.orgId, attemptId: again.id }, now),
    ))!;
    const second = (await res.json()) as { value: string };
    const c1 = JSON.parse(Buffer.from(first.value.split(".")[1]!, "base64url").toString());
    const c2 = JSON.parse(Buffer.from(second.value.split(".")[1]!, "base64url").toString());
    expect([c1.run_attempt, c1.rerun]).toEqual([1, false]);
    expect(c2.attempt_id).toBe(again.id);
    expect(c2.attempt_id).not.toBe(c1.attempt_id);
    expect(c2.run_attempt).toBe(2);
    expect(c2.rerun).toBe(true);
    expect(c2.jti).not.toBe(c1.jti);
  });

  test("a token is valid a little before its iat, and a relying party with a slow clock accepts it", async () => {
    const c = (await relyingParty((await mint(a)).body.value!, a.slug, "sts")).claims;
    expect(c.iat - c.nbf).toBe(NBF_LEEWAY_SECONDS);
    expect(NBF_LEEWAY_SECONDS).toBeLessThanOrEqual(60);
    // The window still ends at exp: leeway on the front never lengthens the lifetime.
    expect(c.exp - c.iat).toBeLessThanOrEqual(MAX_TOKEN_SECONDS);
  });
});

describe("static export", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ls-oidc-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // The CLI opens the database on its own, as a second handle. A PGlite database lives in the
  // handle that made it, so it would see an empty one; a real server (or SQLite) shares it.
  test.skipIf(process.env.LONGSHORE_TEST_DB === "pglite")(
    "longshore oidc export writes discovery and a JWKS with no private parameters",
    async () => {
      const dir = join(tmp, "data");
      const keyFile = join(tmp, "m.key");
      initMasterKey(keyFile);
      const { openDatabase, createOrg, ensureInstance } = await import("../src/db");
      const d = openDatabase(join(dir, "longshore.db"));
      await ensureInstance(d);
      await createOrg(d, { slug: "acme", name: "acme" });
      d.close();
      const out = join(tmp, "site");
      const code = await oidcCommand([
        "export",
        "--org",
        "acme",
        "--data-dir",
        dir,
        "--master-key-file",
        keyFile,
        "--base-url",
        "https://static.example.com/oidc",
        "--out",
        out,
      ]);
      expect(code).toBe(0);
      const disc = JSON.parse(
        readFileSync(join(out, "acme/.well-known/openid-configuration"), "utf8"),
      );
      expect(disc.issuer).toBe("https://static.example.com/oidc/acme");
      expect(disc.jwks_uri).toBe("https://static.example.com/oidc/acme/jwks.json");
      const text = readFileSync(join(out, "acme/jwks.json"), "utf8");
      const jwks = JSON.parse(text) as { keys: Record<string, unknown>[] };
      expect(jwks.keys.length).toBe(1);
      expect(Object.keys(jwks.keys[0]!).toSorted()).toEqual([...PUBLIC_JWK_MEMBERS].toSorted());
      expect(text).not.toContain('"d"');
      // status and rotate work on the same store
      expect(
        await oidcCommand([
          "rotate",
          "--org",
          "acme",
          "--data-dir",
          dir,
          "--master-key-file",
          keyFile,
        ]),
      ).toBe(0);
      expect(loadMasterKey(keyFile).length).toBe(32);
    },
  );
});
