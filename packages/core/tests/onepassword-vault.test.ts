import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { redactString } from "@turntable/redact";
import { type Db } from "../src/db";
import {
  createProject,
  getAttempt,
  getJob,
  getRun,
  listAudit,
  setProxyRule,
} from "../src/db/repos";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import { dispatch, registry, type Credential, type DispatchEnv } from "../src/ops";
import { SecretsProxy, withSecretsProxy } from "../src/proxy";
import { OnePasswordBackend } from "../src/secrets/backends/onepassword";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { account, config, FakeOnePassword, randomToken } from "./op-fake";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";
import { sql } from "drizzle-orm";

const REF = "op://ci/deploy/token";
const HOST = "api.example.com";
const VALUE = `val-${randomToken()}`;
let db: Db;
let a: Tenant;
let b: Tenant;
let fake: FakeOnePassword;
let backend: OnePasswordBackend;
let vault: SecretVault;
let ciToken: string;
let relToken: string;
let now = 1_800_000_000_000;

function build(accounts = [account({ name: "ci", orgs: [a.orgId] })]) {
  fake = new FakeOnePassword();
  fake.values.set(REF, VALUE);
  fake.values.set("op://rel/publish/key", `rel-${randomToken()}`);
  backend = new OnePasswordBackend({
    config: config(accounts, { canary: REF }),
    factory: fake.factory,
    now: () => now,
    log: () => {},
  });
  vault = new SecretVault({ db, masterKey: randomBytes(32), backends: [backend], now: () => now });
}

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  now = 1_800_000_000_000;
  ciToken = randomToken();
  relToken = randomToken();
  build([
    account({
      name: "ci",
      token: ciToken,
      orgs: [a.orgId],
      trustClasses: ["protected", "trusted_pr"],
    }),
    account({
      name: "rel",
      token: relToken,
      vaults: ["rel"],
      orgs: [a.orgId],
      trustClasses: ["release"],
    }),
  ]);
  resetFailureThrottle();
});

const start = (t: Tenant, klass: string | null) =>
  db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: klass })
    .where(eq(s.jobAttempts.id, t.attemptId));

const useReq = (t: Tenant, name = "DEPLOY_KEY") => ({
  orgId: t.orgId,
  projectId: t.projectId,
  runId: t.runId,
  jobId: t.jobId,
  attemptId: t.attemptId,
  name,
  destination: HOST,
});

const bind = (over: Record<string, unknown> = {}, ref = REF) =>
  vault.bindReference(a.orgId, "test", { name: "DEPLOY_KEY", ...over }, "onepassword", ref, {
    destinations: [HOST],
    trustClasses: ["protected", "trusted_pr", "release"],
  });

const everything = async (): Promise<string> =>
  JSON.stringify({
    audit: await db.orm.select().from(s.auditLog),
    secrets: await db.orm.select().from(s.vaultSecrets),
  });

describe("binding a reference", () => {
  test("creates an external secret: no versions, source and reference recorded", async () => {
    const r = await bind();
    expect(r.created).toBe(true);
    expect(r.secret).toMatchObject({
      source: "onepassword",
      external_ref: REF,
      current_version: 0,
      versions: [],
    });
    expect(await db.orm.select().from(s.vaultSecretVersions)).toHaveLength(0);
    expect((await bind()).created).toBe(false);
  });

  test("refuses an unparseable reference, an unserved vault and a missing backend", async () => {
    await expect(bind({}, "nope")).rejects.toThrow();
    await expect(bind({}, "op://unknown/i/f")).rejects.toThrow("no account available to this org");
    const bare = new SecretVault({ db, masterKey: randomBytes(32) });
    await expect(
      bare.bindReference(a.orgId, "t", { name: "X" }, "onepassword", REF),
    ).rejects.toThrow("no onepassword backend");
  });

  test("tenant isolation: another org gets the same error as for an unserved vault", async () => {
    const caught = async (v: SecretVault, org: string, ref: string) => {
      try {
        await v.bindReference(org, "t", { name: "X" }, "onepassword", ref);
      } catch (err) {
        return err as Error & { code?: unknown };
      }
      throw new Error("expected a refusal");
    };
    const unserved = await caught(vault, b.orgId, "op://nobody-serves-this/i/f");
    const notYours = await caught(vault, b.orgId, REF);
    expect(notYours.message).toBe(unserved.message);
    expect(notYours.code).toBe(unserved.code);
    expect(notYours.constructor).toBe(unserved.constructor);
    expect(notYours.message).not.toContain("ci");
    expect((await bind()).created).toBe(true);
  });

  test("project-scoped: a project the account is not bound to cannot bind its vault", async () => {
    const p2 = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
    build([account({ name: "ci", vaults: ["ci"], projects: [a.projectId] })]);
    const bindIn = (projectId: string, ref = REF) =>
      vault.bindReference(a.orgId, "t", { name: "X", projectId }, "onepassword", ref);
    expect((await bindIn(a.projectId)).created).toBe(true);
    const err = await bindIn(p2.id).catch((e: Error) => e);
    const unserved = await bindIn(p2.id, "op://nobody-serves-this/i/f").catch((e: Error) => e);
    expect((err as Error).message).toBe((unserved as Error).message);
    expect((err as Error).message).toContain("no account available to this org");
    // an org-level bind is allowed: the account serves a project of this org
    expect(
      (await vault.bindReference(a.orgId, "t", { name: "Y" }, "onepassword", REF)).created,
    ).toBe(true);
    // another org's project is not this org's
    await expect(
      vault.bindReference(b.orgId, "t", { name: "Z", projectId: a.projectId }, "onepassword", REF),
    ).rejects.toThrow("no account available to this org");
  });

  test("never converts a sealed secret, and set/rotate refuse an external one", async () => {
    await vault.set(a.orgId, "t", { name: "SEALED" }, "sealed-value-123");
    await expect(bind({ name: "SEALED" })).rejects.toThrow("sealed secret has this scope");
    await bind();
    await expect(vault.set(a.orgId, "t", { name: "DEPLOY_KEY" }, "x-value-1234")).rejects.toThrow(
      "external reference",
    );
    await expect(
      vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "x-value-1234"),
    ).rejects.toThrow("external reference");
  });

  test("unbind removes a reference and refuses a sealed secret", async () => {
    await vault.set(a.orgId, "t", { name: "SEALED" }, "sealed-value-123");
    await expect(vault.unbindReference(a.orgId, { name: "SEALED" })).rejects.toThrow("sealed");
    await bind();
    expect((await vault.unbindReference(a.orgId, { name: "DEPLOY_KEY" }))?.external_ref).toBe(REF);
    expect(await vault.unbindReference(a.orgId, { name: "DEPLOY_KEY" })).toBeUndefined();
  });

  test("the CHECK constraint: sealed needs versions and no reference, external needs a reference and none", async () => {
    const insert = (source: string, ref: string | null, version: number) =>
      rawExec(
        db.orm,
        sql`insert into vault_secrets (id, org_id, name, scope_key, trust_classes, destinations, current_version, source, external_ref, created_by, created_at, updated_at) values (${`id${Math.random()}`}, ${a.orgId}, ${`n${Math.random()}`}, ${`k${Math.random()}`}, '[]', '[]', ${version}, ${source}, ${ref}, 'x', 1, 1)`,
      );
    await expect(insert("sealed", REF, 1)).rejects.toThrow();
    await expect(insert("sealed", null, 0)).rejects.toThrow();
    await expect(insert("onepassword", null, 0)).rejects.toThrow();
    await expect(insert("onepassword", REF, 1)).rejects.toThrow();
    await insert("sealed", null, 1);
    await insert("onepassword", REF, 0);
  });
});

describe("use", () => {
  test("resolves through the proxy path's policy, audits names and never the value", async () => {
    await bind();
    await start(a, "protected");
    const r = await vault.use(useReq(a));
    expect(r).toMatchObject({ ok: true, value: VALUE, version: 0 });
    const audit = (await listAudit(db, a.scope)).find((x) => x.op === "secret_use");
    expect(JSON.parse(audit!.input as string)).toMatchObject({
      secret: "DEPLOY_KEY",
      source: "onepassword",
      account: "ci",
      vault: "ci",
      item: "deploy",
      field: "token",
      run: a.runId,
      attempt: a.attemptId,
      class: "protected",
    });
    expect(await everything()).not.toContain(VALUE);
  });

  test("a PR-class job never resolves through the release account; a CI-class job is refused it too", async () => {
    await bind({ name: "PUBLISH" }, "op://rel/publish/key");
    // trusted_pr and untrusted_pr never hold secrets at all: refused before any account is looked at.
    for (const klass of ["trusted_pr", "untrusted_pr"]) {
      await start(a, klass);
      expect((await vault.use(useReq(a, "PUBLISH"))).ok).toBe(false);
    }
    // A protected job reaches the account check, and the account is bound only to release.
    await start(a, "protected");
    expect(await vault.use(useReq(a, "PUBLISH"))).toEqual({
      ok: false,
      reason: "account_not_bound",
    });
    expect(fake.calls).toHaveLength(0);
    const text = await everything();
    expect(text).toContain("account_not_bound");
    expect(text).toContain('account\\":\\"rel');
  });

  test("an account bound to another org's projects does not serve this org", async () => {
    await bind();
    build([account({ name: "ci", orgs: [b.orgId], trustClasses: ["protected"] })]);
    await start(a, "protected");
    expect(await vault.use(useReq(a))).toEqual({ ok: false, reason: "account_not_bound" });
    expect(fake.calls).toHaveLength(0);
  });

  test("an account bound to a project serves that project only", async () => {
    build([account({ name: "ci", projects: [a.projectId], trustClasses: ["protected"] })]);
    await bind();
    await start(a, "protected");
    expect((await vault.use(useReq(a))).ok).toBe(true);
  });

  test("destination and class policy still apply before anything is read", async () => {
    await bind({}, REF);
    await start(a, "protected");
    expect(await vault.use({ ...useReq(a), destination: "evil.example.net" })).toEqual({
      ok: false,
      reason: "destination_not_allowed",
    });
    await start(a, "untrusted_pr");
    expect((await vault.use(useReq(a))).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("the main lane refuses a release-class external secret before the backend is asked", async () => {
    await bind({ name: "PUBLISH" }, "op://rel/publish/key");
    await start(a, "release");
    expect(await vault.use(useReq(a, "PUBLISH"))).toEqual({
      ok: false,
      reason: "release_lane_only",
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("the release lane resolves a release-class external secret for a publish", async () => {
    await bind({ name: "PUBLISH" }, "op://rel/publish/key");
    const lane = new SecretVault({
      db,
      masterKey: randomBytes(32),
      lane: "release",
      backends: [backend],
    });
    const r = await lane.usePublishCredential({
      orgId: a.orgId,
      projectId: a.projectId,
      name: "PUBLISH",
      destination: HOST,
      tag: "v1",
      requestId: "req1",
    });
    expect(r.ok).toBe(true);
  });

  test("fails closed on outage, rate limit and auth failure: refused, audited, no value", async () => {
    await bind();
    await start(a, "protected");
    // rate_limited last: it blocks the account locally for a while.
    for (const kind of ["outage", "auth", "not_found", "rate_limited"] as const) {
      resetFailureThrottle();
      backend.refresh();
      fake.failWith = kind;
      const r = await vault.use(useReq(a));
      expect(r).toEqual({ ok: false, reason: "backend_unavailable" });
    }
    expect(await everything()).toContain('error_kind\\":\\"rate_limited');
    expect(await everything()).not.toContain(VALUE);
  });

  test("a value is never served stale past its TTL when the backend then fails", async () => {
    await bind();
    await start(a, "protected");
    expect((await vault.use(useReq(a))).ok).toBe(true);
    now += 301_000;
    fake.failWith = "outage";
    expect(await vault.use(useReq(a))).toEqual({ ok: false, reason: "backend_unavailable" });
  });

  test("a secret whose backend is gone is refused as unavailable", async () => {
    await bind();
    await start(a, "protected");
    const bare = new SecretVault({ db, masterKey: randomBytes(32) });
    expect(await bare.use(useReq(a))).toEqual({ ok: false, reason: "backend_unavailable" });
  });

  test("concurrent uses of one reference make one read", async () => {
    await bind();
    await start(a, "protected");
    let open!: () => void;
    fake.gate = new Promise<void>((r) => (open = r));
    const all = Promise.all(Array.from({ length: 10 }, () => vault.use(useReq(a))));
    await Bun.sleep(20);
    open();
    expect((await all).every((r) => r.ok)).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  test("a rotated upstream value is picked up after the TTL or after refresh", async () => {
    await bind();
    await start(a, "protected");
    await vault.use(useReq(a));
    const rotated = `rot-${randomToken()}`;
    fake.values.set(REF, rotated);
    expect((await vault.use(useReq(a))) as { value: string }).toMatchObject({ value: VALUE });
    expect(vault.refreshBackends()).toBe(1);
    expect((await vault.use(useReq(a))) as { value: string }).toMatchObject({ value: rotated });
  });

  test("every service-account token is on the redactor's list, and none is ever audited or returned", async () => {
    expect(vault.backendTokens().sort()).toEqual([ciToken, relToken].sort());
    await bind();
    await start(a, "protected");
    await vault.use(useReq(a));
    const text = await everything();
    expect(text).not.toContain(ciToken);
    expect(text).not.toContain(relToken);
    expect(JSON.stringify(await vault.backendHealth())).not.toContain(ciToken);
  });
});

describe("operations", () => {
  const env = (): DispatchEnv => ({ registry, db, now: () => now, vault });

  test("bind, list, refresh, doctor and unbind; admin only", async () => {
    const admin: Credential = {
      kind: "principal",
      principal: { kind: "member", id: "m", orgId: a.orgId, role: "admin" },
    };
    const relop = (await mintToken(db, a.scope, "release_operator")).secret;
    const call = (cred: string | Credential, op: string, input: unknown) =>
      dispatch(env(), typeof cred === "string" ? { kind: "bearer", token: cred } : cred, op, input);
    const input = { name: "DEPLOY_KEY", reference: REF, destinations: [HOST] };
    expect((await call(relop, "bind_secret_reference", input)).ok).toBe(false);
    const bound = await call(admin, "bind_secret_reference", input);
    expect(bound.ok).toBe(true);
    const listed = await call(admin, "list_secrets", {});
    expect(JSON.stringify(listed)).toContain(REF);
    expect((await call(relop, "refresh_secrets", {})).ok).toBe(false);
    expect(await call(admin, "refresh_secrets", {})).toMatchObject({
      ok: true,
      output: { dropped: 0 },
    });
    const doctor = await call(admin, "doctor_secrets", {});
    expect(doctor).toMatchObject({ ok: true });
    const text = JSON.stringify(doctor);
    expect(text).toContain('"reachable":true');
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(ciToken);
    expect((await call(relop, "unbind_secret_reference", { name: "DEPLOY_KEY" })).ok).toBe(false);
    expect((await call(admin, "unbind_secret_reference", { name: "DEPLOY_KEY" })).ok).toBe(true);
    const ops = (await listAudit(db, a.scope)).map((x) => x.op);
    expect(ops).toContain("bind_secret_reference");
    expect(ops).toContain("unbind_secret_reference");
    expect(ops).toContain("refresh_secrets");
  });
});

describe("through the secrets proxy", () => {
  const done: AttemptOutcome = { state: "success", reason: "ok" };
  let proxy: SecretsProxy;

  async function ctxOf(): Promise<AttemptContext> {
    return {
      run: (await getRun(db, a.scope, a.runId))!,
      job: (await getJob(db, a.scope, a.jobId))!,
      attempt: (await getAttempt(db, a.scope, a.attemptId))!,
      scope: a.scope,
      provider: {} as AttemptContext["provider"],
      signal: new AbortController().signal,
      store: {} as AttemptContext["store"],
    };
  }

  async function seed(): Promise<void> {
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }) })
      .where(eq(s.runs.id, a.runId));
    await start(a, "protected");
    await bind({ projectId: a.projectId });
    await setProxyRule(db, a.scope, "t", {
      name: "api",
      secret: "DEPLOY_KEY",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
  }

  const seen: Headers[] = [];
  beforeEach(async () => {
    seen.length = 0;
    proxy = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      upstream: async (_u, init) => (seen.push(new Headers(init?.headers)), new Response("ok")),
      tunnel: async () => {
        throw new Error("no passthrough");
      },
    });
  });

  async function request(c: AttemptContext & { proxy?: NonNullable<AttemptContext["proxy"]> }) {
    const raw = net.connect(proxy.port, "127.0.0.1");
    await new Promise<void>((r) => raw.once("connect", () => r()));
    const basic = Buffer.from(
      `${c.proxy!.credential.username}:${c.proxy!.credential.password}`,
    ).toString("base64");
    raw.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
    );
    await new Promise<void>((r) => raw.once("data", () => r()));
    const secure = tls.connect({ socket: raw, servername: HOST, ca: c.proxy!.credential.caPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    secure.write(`GET /v1/x HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
    const chunks: Buffer[] = [];
    for await (const d of secure) chunks.push(d as Buffer);
    return Number(/^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(chunks).toString())?.[1]);
  }

  test("injects the resolved value; the token and value are redacted in the attempt's log registry", async () => {
    await seed();
    let status = 0;
    let masked = "";
    await withSecretsProxy(
      async (c) => {
        status = await request(c);
        masked = redactString(`a ${VALUE} b ${ciToken} c ${relToken}`, c.redact!);
        return done;
      },
      { proxy },
    )(await ctxOf());
    await proxy.stop();
    expect(status).toBe(200);
    expect(seen[0]?.get("authorization")).toBe(`Bearer ${VALUE}`);
    for (const secret of [VALUE, ciToken, relToken]) expect(masked).not.toContain(secret);
  });

  test("a backend outage refuses the request and the failed attempt reports infra_error", async () => {
    await seed();
    fake.failWith = "outage";
    let status = 0;
    const out = await withSecretsProxy(
      async (c) => {
        status = await request(c);
        return { state: "failure", reason: "request failed" };
      },
      { proxy },
    )(await ctxOf());
    await proxy.stop();
    expect(status).toBe(502);
    expect(seen).toHaveLength(0);
    expect(out.state).toBe("infra_error");
  });

  test("a policy refusal (not an outage) leaves a failed attempt failed", async () => {
    await seed();
    build([account({ name: "ci", orgs: [b.orgId] })]);
    // Same vault, but the vault this proxy uses is the new one; rebuild the proxy on it.
    await proxy.stop();
    proxy = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      upstream: async () => new Response("ok"),
      tunnel: async () => {
        throw new Error("no");
      },
    });
    const out = await withSecretsProxy(
      async (c) => {
        await request(c);
        return { state: "failure", reason: "request failed" };
      },
      { proxy },
    )(await ctxOf());
    await proxy.stop();
    expect(out.state).toBe("failure");
  });
});
