import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { chainedAudit, createOrg, createProject, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import {
  domainKey,
  isLegacyRecord,
  open,
  seal,
  sealLegacyV1,
  secretAad,
  SecretDecryptError,
  vaultAad,
} from "../src/secrets/crypto";
import { SecretStore } from "../src/secrets/store";
import { hostAllowed, SecretVault, VaultInputError } from "../src/secrets/vault";
import { seedWorld, type Tenant } from "./ops-helpers";

const SENTINEL = "s3ntinel-vault-value-9f2c";
const masterKey = randomBytes(32);
let db: Db;
let a: Tenant;
let b: Tenant;
let vault: SecretVault;
let now = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  now = 1_800_000_000_000;
  vault = new SecretVault({ db, masterKey, now: () => now });
  resetFailureThrottle();
});

/** Makes the attempt look like the scheduler started it as `klass`. */
const start = async (t: Tenant, klass: string | null, state = "running") => {
  await db.orm
    .update(s.jobAttempts)
    .set({ state, trustClass: klass })
    .where(eq(s.jobAttempts.id, t.attemptId));
};

const useReq = (t: Tenant, name = "DEPLOY_KEY", destination = "api.example.com") => ({
  orgId: t.orgId,
  projectId: t.projectId,
  runId: t.runId,
  jobId: t.jobId,
  attemptId: t.attemptId,
  name,
  destination,
});

const baseSet = (t: Tenant, extra: Record<string, unknown> = {}) =>
  vault.set(t.orgId, "test", { name: "DEPLOY_KEY", ...extra }, SENTINEL, {
    destinations: ["api.example.com"],
    ...(extra.policy as object | undefined),
  });

describe("key domains", () => {
  const aad = secretAad("o", "n");
  test("a record opens only in the domain it was sealed for", () => {
    const rec = seal(masterKey, "v", aad, "job");
    expect(open(masterKey, rec, aad, "job")).toBe("v");
    expect(() => open(masterKey, rec, aad, "system")).toThrow(SecretDecryptError);
    const sys = seal(masterKey, "v", aad, "system");
    expect(() => open(masterKey, sys, aad, "job")).toThrow(SecretDecryptError);
    expect(domainKey(masterKey, "job").equals(domainKey(masterKey, "system"))).toBe(false);
  });

  test("legacy v1 records still open for the system store, never for the vault", () => {
    const old = sealLegacyV1(masterKey, "legacy", aad);
    expect(isLegacyRecord(old)).toBe(true);
    expect(open(masterKey, old, aad, "system")).toBe("legacy");
    expect(() => open(masterKey, old, aad, "job")).toThrow(SecretDecryptError);
  });

  test("the system store reads a legacy record and writes v2 on the next set", async () => {
    const store = new SecretStore(db, masterKey);
    const { putSecretRecord, getSecretRecord } = await import("../src/db");
    await putSecretRecord(
      db,
      { orgId: a.orgId },
      "audit/signing-key",
      sealLegacyV1(masterKey, "k1", secretAad(a.orgId, "audit/signing-key")),
    );
    expect(await store.get(a.orgId, "audit/signing-key")).toBe("k1");
    await store.set(a.orgId, "audit/signing-key", "k2");
    expect(
      isLegacyRecord((await getSecretRecord(db, { orgId: a.orgId }, "audit/signing-key"))!),
    ).toBe(false);
    expect(await store.get(a.orgId, "audit/signing-key")).toBe("k2");
  });

  test("vault AAD binds org, secret id, version and name", () => {
    const rec = seal(masterKey, "v", vaultAad("o", "id1", 1, "N"), "job");
    for (const bad of [
      vaultAad("o2", "id1", 1, "N"),
      vaultAad("o", "id2", 1, "N"),
      vaultAad("o", "id1", 2, "N"),
      vaultAad("o", "id1", 1, "M"),
    ]) {
      expect(() => open(masterKey, rec, bad, "job")).toThrow(SecretDecryptError);
    }
  });
});

describe("writes", () => {
  test("untrusted_pr can never be allowed, and unknown classes and bad hosts are refused", async () => {
    await expect(
      baseSet(a, { policy: { trustClasses: ["protected", "untrusted_pr"] } }),
    ).rejects.toThrow(/untrusted_pr/);
    await expect(baseSet(a, { policy: { trustClasses: ["nope"] } })).rejects.toBeInstanceOf(
      VaultInputError,
    );
    for (const d of ["*", "*.com", "http://x", "a b", "evil.com/x"]) {
      await expect(baseSet(a, { policy: { destinations: [d] } })).rejects.toBeInstanceOf(
        VaultInputError,
      );
    }
    await expect(vault.set(a.orgId, "t", { name: "bad name" }, "v")).rejects.toBeInstanceOf(
      VaultInputError,
    );
    await expect(vault.set(a.orgId, "t", { name: "A/B" }, "v")).rejects.toBeInstanceOf(
      VaultInputError,
    );
    await expect(vault.set(a.orgId, "t", { name: "A" }, "")).rejects.toBeInstanceOf(
      VaultInputError,
    );
  });

  test("defaults: protected and release only, deliverable nowhere", async () => {
    const r = await vault.set(a.orgId, "t", { name: "K" }, SENTINEL);
    expect(r.secret.trust_classes).toEqual(["protected", "release"]);
    expect(r.secret.destinations).toEqual([]);
  });

  test("setting an existing scope adds a version and retires the old one at once", async () => {
    const r1 = await baseSet(a);
    const r2 = await vault.set(a.orgId, "t", { name: "DEPLOY_KEY" }, "second", {
      destinations: ["api.example.com"],
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.secret.current_version).toBe(2);
    await start(a, "protected");
    expect((await vault.use({ ...useReq(a), version: 1 })).ok).toBe(false);
    const u = await vault.use(useReq(a));
    expect(u).toMatchObject({ ok: true, value: "second", version: 2 });
  });

  test("the same name can live in different scopes", async () => {
    await baseSet(a);
    await baseSet(a, { environment: "prod" });
    await baseSet(a, { refPattern: "release/*" });
    expect((await vault.list(a.orgId)).length).toBe(3);
  });

  test("listings carry metadata only", async () => {
    await baseSet(a);
    await start(a, "protected");
    await vault.use(useReq(a));
    const text = JSON.stringify(await vault.list(a.orgId));
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("last_used_at");
  });

  test("tenants are separate", async () => {
    await baseSet(a);
    expect(await vault.list(b.orgId)).toEqual([]);
    expect(await vault.delete(b.orgId, { name: "DEPLOY_KEY" })).toBeUndefined();
    expect(await vault.rotate(b.orgId, "t", { name: "DEPLOY_KEY" }, "x")).toBeUndefined();
  });
});

describe("policy", () => {
  const denied = async (reason: string, req = useReq(a)) => {
    const r = await vault.use(req);
    expect(r).toEqual({ ok: false, reason } as never);
  };

  test("allowed: protected class, matching destination; audited with run, job, attempt, destination", async () => {
    await baseSet(a);
    await start(a, "protected");
    const r = await vault.use(useReq(a));
    expect(r).toMatchObject({ ok: true, value: SENTINEL, version: 1 });
    const used = (await chainedAudit(db, a.orgId, 0, 100)).find((x) => x.op === "secret_use")!;
    expect(used.outcome).toBe("ok");
    const input = JSON.parse(used.input);
    expect(input).toMatchObject({
      secret: "DEPLOY_KEY",
      run: a.runId,
      job: a.jobId,
      attempt: a.attemptId,
      destination: "api.example.com",
      class: "protected",
    });
    expect(used.input).not.toContain(SENTINEL);
    expect((await vault.list(a.orgId))[0]!.last_used_at).toBe(now);
  });

  test("the class comes from the attempt record: unrecorded, untrusted and trusted PR runs are refused", async () => {
    await baseSet(a, { policy: { trustClasses: ["protected", "release", "trusted_pr"] } });
    await start(a, null);
    await denied("class_unrecorded");
    await start(a, "untrusted_pr");
    await denied("class_not_allowed");
    await start(a, "trusted_pr"); // allowed by the secret, not by credentialsFor
    await denied("class_not_allowed");
    await start(a, "protected");
    expect((await vault.use(useReq(a))).ok).toBe(true);
  });

  test("a stored untrusted_pr in the secret's own policy is still refused at use", async () => {
    await baseSet(a);
    await db.orm
      .update(s.vaultSecrets)
      .set({ trustClasses: JSON.stringify(["protected", "untrusted_pr"]) });
    await start(a, "untrusted_pr");
    await denied("class_not_allowed");
  });

  test("class must be in the secret's list", async () => {
    await baseSet(a, { policy: { trustClasses: ["release"] } });
    await start(a, "protected");
    await denied("class_not_allowed");
  });

  test("destinations: exact, wildcard subdomain, bare suffix refused, empty list means nowhere", async () => {
    await start(a, "protected");
    await vault.set(a.orgId, "t", { name: "NODEST" }, SENTINEL);
    await denied("destination_not_allowed", useReq(a, "NODEST", "api.example.com"));
    await vault.set(a.orgId, "t", { name: "W" }, SENTINEL, { destinations: ["*.example.com"] });
    expect((await vault.use(useReq(a, "W", "a.b.example.com"))).ok).toBe(true);
    await denied("destination_not_allowed", useReq(a, "W", "example.com"));
    await denied("destination_not_allowed", useReq(a, "W", "evilexample.com"));
    await denied("destination_not_allowed", useReq(a, "W", "example.com.evil.net"));
    expect(hostAllowed(["api.example.com"], "API.EXAMPLE.COM.")).toBe(true);
  });

  test("scope matching: project, ref, environment", async () => {
    await start(a, "protected");
    const p2 = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
    await baseSet(a, { projectId: p2.id });
    await denied("no_match"); // another project's secret
    await vault.set(a.orgId, "t", { name: "REL", refPattern: "refs/tags/v*" }, SENTINEL, {
      destinations: ["api.example.com"],
    });
    await denied("no_match", useReq(a, "REL")); // run is on main
    await vault.set(a.orgId, "t", { name: "ENV", environment: "prod" }, SENTINEL, {
      destinations: ["api.example.com"],
    });
    await denied("environment_unavailable", useReq(a, "ENV"));
    await vault.set(a.orgId, "t", { name: "MAIN", refPattern: "main" }, SENTINEL, {
      destinations: ["api.example.com"],
    });
    expect((await vault.use(useReq(a, "MAIN"))).ok).toBe(true);
  });

  test("precedence: project beats org; a tie is an error, never a guess", async () => {
    await start(a, "protected");
    const pol = { destinations: ["api.example.com"] };
    await vault.set(a.orgId, "t", { name: "K" }, "org-value", pol);
    await vault.set(a.orgId, "t", { name: "K", projectId: a.projectId }, "project-value", pol);
    expect(await vault.use(useReq(a, "K"))).toMatchObject({ ok: true, value: "project-value" });
    await vault.set(a.orgId, "t", { name: "T", refPattern: "main" }, "one", pol);
    await vault.set(a.orgId, "t", { name: "T", refPattern: "refs/heads/*" }, "two", pol);
    await denied("ambiguous", useReq(a, "T"));
  });

  test("the attempt must be running and belong to the run and job", async () => {
    await baseSet(a);
    await start(a, "protected", "queued");
    await denied("attempt_not_running");
    await start(a, "protected");
    await denied("unknown_run", { ...useReq(a), jobId: b.jobId });
    await denied("unknown_run", { ...useReq(a), attemptId: b.attemptId });
    await denied("unknown_run", { ...useReq(a), runId: "nope" });
    // another org's ids under this org's scope find nothing
    await start(b, "protected");
    await denied("unknown_run", { ...useReq(b), orgId: a.orgId, projectId: a.projectId });
  });

  test("tampering fails closed: swapped or edited ciphertext does not open", async () => {
    await vault.set(a.orgId, "t", { name: "ONE" }, "one", { destinations: ["api.example.com"] });
    await vault.set(a.orgId, "t", { name: "TWO" }, "two", { destinations: ["api.example.com"] });
    await start(a, "protected");
    const [one, two] = await db.orm.select().from(s.vaultSecretVersions);
    await db.orm
      .update(s.vaultSecretVersions)
      .set({ ciphertext: two!.ciphertext })
      .where(eq(s.vaultSecretVersions.secretId, one!.secretId));
    const r = await vault.use(useReq(a, "ONE"));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe("decrypt_failed");
  });

  test("denials are audited (throttled per attempt) and never carry a value", async () => {
    await baseSet(a);
    await start(a, "untrusted_pr");
    for (let i = 0; i < 20; i++) await vault.use(useReq(a));
    const rows = (await chainedAudit(db, a.orgId, 0, 100)).filter((x) => x.op === "secret_use");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(20);
    expect(rows[0]!.outcome).toBe("error:class_not_allowed");
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });
});

describe("rotation", () => {
  test("overlap keeps the old version usable until the window ends", async () => {
    await baseSet(a);
    await start(a, "protected");
    await vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "new-value", 60_000);
    expect(await vault.use({ ...useReq(a), version: 1 })).toMatchObject({
      ok: true,
      value: SENTINEL,
    });
    expect(await vault.use(useReq(a))).toMatchObject({ ok: true, value: "new-value", version: 2 });
    now += 60_001;
    expect(await vault.use({ ...useReq(a), version: 1 })).toEqual({
      ok: false,
      reason: "version_unavailable",
    });
    expect((await vault.use({ ...useReq(a), version: 9 })).ok).toBe(false);
  });

  test("no overlap by default; overlap is capped at 7 days", async () => {
    await baseSet(a);
    await start(a, "protected");
    await vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "x");
    expect((await vault.use({ ...useReq(a), version: 1 })).ok).toBe(false);
    await expect(
      vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "y", 8 * 86_400_000),
    ).rejects.toBeInstanceOf(VaultInputError);
    await expect(
      vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "y", -1),
    ).rejects.toBeInstanceOf(VaultInputError);
  });

  test("delete removes every version", async () => {
    await baseSet(a);
    await vault.rotate(a.orgId, "t", { name: "DEPLOY_KEY" }, "x", 1000);
    const r = await vault.delete(a.orgId, { name: "DEPLOY_KEY" });
    expect(r?.versions.length).toBe(2);
    expect(await db.orm.select().from(s.vaultSecretVersions)).toEqual([]);
  });
});

test("system secrets are in a different table and unreachable from the vault", async () => {
  const store = new SecretStore(db, masterKey);
  await store.set(a.orgId, "audit/signing-key", "PRIVATE");
  await store.set(a.orgId, "github-app/private-key", "PRIVATE");
  expect(await vault.list(a.orgId)).toEqual([]);
  await expect(vault.set(a.orgId, "t", { name: "audit/signing-key" }, "x")).rejects.toBeInstanceOf(
    VaultInputError,
  );
  expect(await vault.delete(a.orgId, { name: "DEPLOY_KEY" })).toBeUndefined();
  expect(await store.get(a.orgId, "audit/signing-key")).toBe("PRIVATE");
  void createOrg;
});

describe("publish credentials (release lane only)", () => {
  const pub = (
    t: Tenant,
    name = "NPM_TOKEN",
    destination = "registry.npmjs.org",
    tag = "v1.0.0",
  ) => ({
    orgId: t.orgId,
    projectId: t.projectId,
    name,
    destination,
    tag,
    requestId: "req-1",
  });
  const setNpm = (extra: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) =>
    vault.set(a.orgId, "t", { name: "NPM_TOKEN", ...extra }, SENTINEL, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
      ...policy,
    });
  let lane: SecretVault;
  beforeEach(() => {
    lane = new SecretVault({ db, masterKey, lane: "release", now: () => now });
  });

  test("the main lane can never use one", async () => {
    await setNpm();
    expect(await vault.usePublishCredential(pub(a))).toEqual({
      ok: false,
      reason: "release_lane_only",
    } as never);
  });

  test("the release lane gets the value for an allowed destination, audited without it", async () => {
    await setNpm();
    expect(await lane.usePublishCredential(pub(a))).toMatchObject({ ok: true, value: SENTINEL });
    const used = (await chainedAudit(db, a.orgId, 0, 100)).find((x) => x.op === "secret_use")!;
    expect(used.outcome).toBe("ok");
    expect(JSON.parse(used.input)).toMatchObject({ secret: "NPM_TOKEN", request: "req-1" });
    expect(used.input).not.toContain(SENTINEL);
  });

  test("refused: other destination, wrong class, ref mismatch, environment, other project", async () => {
    await setNpm();
    expect((await lane.usePublishCredential(pub(a, "NPM_TOKEN", "evil.example.com"))).ok).toBe(
      false,
    );
    expect(await lane.usePublishCredential(pub(a, "MISSING"))).toMatchObject({
      reason: "no_match",
    });

    await vault.set(a.orgId, "t", { name: "PROT" }, SENTINEL, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["protected"],
    });
    expect(await lane.usePublishCredential(pub(a, "PROT"))).toMatchObject({
      reason: "class_not_allowed",
    });

    await vault.set(a.orgId, "t", { name: "REF", refPattern: "refs/tags/v2.*" }, SENTINEL, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
    });
    expect(await lane.usePublishCredential(pub(a, "REF"))).toMatchObject({ reason: "no_match" });

    await vault.set(a.orgId, "t", { name: "ENV", environment: "prod" }, SENTINEL, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
    });
    expect(await lane.usePublishCredential(pub(a, "ENV"))).toMatchObject({ reason: "no_match" });

    const p2 = await createProject(db, { orgId: a.orgId }, { slug: "other2", name: "Other2" });
    await vault.set(a.orgId, "t", { name: "OTHER", projectId: p2.id }, SENTINEL, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
    });
    expect(await lane.usePublishCredential(pub(a, "OTHER"))).toMatchObject({ reason: "no_match" });
    const denied = (await chainedAudit(db, a.orgId, 0, 200)).filter((x) =>
      x.outcome.startsWith("error:"),
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(JSON.stringify(denied)).not.toContain(SENTINEL);
  });
});
