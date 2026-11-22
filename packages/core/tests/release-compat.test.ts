import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tarDirectory } from "@longshore/act-runner";
import type { SafeFetch } from "@longshore/net";
import { checkBody, compileRules } from "@longshore/proxy";
import { chainedAudit, createReleaseRequest, setFreeze, clearFreeze, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import { SecretVault } from "../src/secrets/vault";
import { AttestationStore } from "../src/release/attest";
import { compatRules, RELEASE_GITHUB_SECRET } from "../src/release/compat";
import { ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import { parseTarget } from "../src/release/publish/config";
import { integrityOf } from "../src/release/publish/npm";
import type { PublishTarget } from "../src/release/publish/types";
import { ReleaseProxy } from "../src/release/proxy";
import { seedWorld, type Tenant } from "./ops-helpers";

const SHA = "b".repeat(40);
const TOKEN_NPM = ["npm", "publish", "token", "77ac10"].join("_");
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "ls-compat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function tarball(pkg: Record<string, unknown>): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(join(d, "package", "package.json"), JSON.stringify(pkg));
  return tarDirectory(d, ["package"]);
}

const NPM: PublishTarget = {
  kind: "npm",
  mode: "compat",
  package: "@acme/web",
  artifact: "web-1.0.0.tgz",
  tag: "latest",
  access: "public",
  secret: "NPM_TOKEN",
};
const GH: PublishTarget = {
  kind: "github-release",
  mode: "compat",
  assets: ["cli-linux"],
  provenanceAsset: null,
};
const OCI: PublishTarget = {
  kind: "oci-image",
  mode: "compat",
  registry: "ghcr.io",
  repository: "acme/web",
  manifest: "manifest.json",
  tags: ["v1.0.0", "latest"],
  username: "bot",
  secret: "REGISTRY_TOKEN",
};
const rel = {
  repo: "acme/web",
  tag: "v1.0.0",
  digests: { "web-1.0.0.tgz": sha256("t"), "cli-linux": sha256("c"), "manifest.json": sha256("m") },
};

describe("rules for compat targets", () => {
  test("npm: the package path, the attested tarball and only that", () => {
    const rules = compatRules("npm", NPM, rel);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      host: "registry.npmjs.org",
      npmPackage: "@acme/web",
      pathPrefix: "/@acme%2Fweb",
      secret: "NPM_TOKEN",
      bodyCheck: { type: "npm-publish", digests: [rel.digests["web-1.0.0.tgz"]] },
    });
    expect(() => compileRules(rules)).not.toThrow();
  });

  test("github: read, draft-only create, upload; the lane's own credential", () => {
    const rules = compatRules("gh", GH, rel);
    expect(rules.map((r) => `${r.host} ${r.methods.join(",")} ${r.pathPrefix}`)).toEqual([
      "api.github.com GET /repos/acme/web/releases",
      "api.github.com POST /repos/acme/web/releases",
      "uploads.github.com POST /repos/acme/web/releases",
    ]);
    expect(rules.every((r) => r.secret === RELEASE_GITHUB_SECRET)).toBe(true);
    expect(rules[1]).toMatchObject({
      pathExact: true,
      bodyCheck: { field: "draft", equals: true },
    });
    expect(() => compileRules(rules)).not.toThrow();
  });

  test("oci: ping, blobs, manifest reads, and a manifest write only for the attested digest under the approved references", () => {
    const rules = compatRules("img", OCI, rel);
    expect(() => compileRules(rules)).not.toThrow();
    const writes = rules.filter((r) => r.methods.includes("PUT") && r.id.includes("manifest-"));
    expect(writes.map((r) => r.pathPrefix)).toEqual([
      "/v2/acme/web/manifests/v1.0.0",
      "/v2/acme/web/manifests/latest",
      `/v2/acme/web/manifests/sha256:${rel.digests["manifest.json"]}`,
    ]);
    for (const w of writes) {
      expect(w.pathExact).toBe(true);
      expect(w.bodyCheck).toEqual({ type: "sha256", digests: [rel.digests["manifest.json"]] });
    }
    expect(rules.every((r) => r.pathPrefix.startsWith("/v2/"))).toBe(true);
    expect(rules.find((r) => r.id === "img:blobs")!.methods).not.toContain("DELETE");
  });

  test("strict targets and unattested artifacts give no rules", () => {
    expect(compatRules("npm", { ...NPM, mode: "strict" } as PublishTarget, rel)).toEqual([]);
    expect(compatRules("npm", NPM, { ...rel, digests: {} })).toEqual([]);
    expect(compatRules("img", OCI, { ...rel, digests: {} })).toEqual([]);
  });

  test("declarations: mode and image fields are validated", () => {
    expect(parseTarget({ ...NPM, mode: undefined })).toMatchObject({ mode: "strict" });
    expect(() => parseTarget({ ...NPM, mode: "other" })).toThrow();
    expect(parseTarget(OCI)).toMatchObject({ kind: "oci-image", mode: "compat" });
    for (const bad of [
      { ...OCI, mode: "strict" },
      { ...OCI, registry: "GHCR.io" },
      { ...OCI, repository: "Acme/Web" },
      { ...OCI, tags: [] },
      { ...OCI, tags: ["bad tag"] },
      { ...OCI, username: "a:b" },
      { ...OCI, manifest: "../m" },
    ]) {
      expect(() => parseTarget(bad)).toThrow();
    }
  });
});

describe("the release proxy", () => {
  let db: Db;
  let a: Tenant;
  let attest: AttestationStore;
  let vault: SecretVault;
  let blobs: Map<string, Uint8Array>;
  let npmTar: Uint8Array;
  let tagSha = SHA;
  let proxy: ReleaseProxy | undefined;
  let seen: { url: string; method: string; auth: string; body: string }[];

  const signer: ReleaseSigner = {
    async signRelease(_s, req) {
      return {
        ok: true,
        envelope: { payloadType: "x", payload: "eA==", signatures: [{ keyid: "k", sig: "eQ==" }] },
        keyid: "k",
        subjects: req.verified.subjects.map((x) => ({ ...x })),
      };
    },
  };
  const upstream: SafeFetch = async (input, init) => {
    const h = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as Uint8Array).toString() : "";
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: h.get("authorization") ?? "",
      body,
    });
    return new Response("{}", { status: 201 });
  };
  const makeLane = () =>
    new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: tagSha }) },
      bytes: { read: async (_r, n) => blobs.get(n) },
      records: {
        async recorded(_s, _r, names) {
          return names.map((n) => ({ name: n, sha256: sha256(blobs.get(n)!) }));
        },
      },
      attest,
      signer,
      owner: "lane-1",
      now: () => 1_800_000_000_000,
    });
  const startProxy = async () =>
    ReleaseProxy.start({
      db,
      vault,
      attest,
      forge: { tagCommit: async () => ({ found: true, sha: tagSha }) },
      githubToken: async () => undefined,
      upstream,
    });
  const sign = async () => {
    await createReleaseRequest(db, a.scope, {
      runId: a.runId,
      tag: "v1.0.0",
      artifacts: ["web-1.0.0.tgz"],
      requestedBy: "t",
    });
    expect(await makeLane().processNext()).toBe(true);
  };
  const reg = (attemptId = "att-1") =>
    proxy!.register({
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      jobId: a.jobId,
      attemptId,
      ttlMs: 60_000,
    });
  const outcomes = async () =>
    (await chainedAudit(db, a.orgId, 0, 500)).map((r) => `${r.op}:${r.outcome}`);

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    resetFailureThrottle();
    tagSha = SHA;
    seen = [];
    npmTar = await tarball({ name: "@acme/web", version: "1.0.0" });
    blobs = new Map([["web-1.0.0.tgz", npmTar]]);
    attest = new AttestationStore(":memory:");
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    attest.setPublishTarget(a.orgId, a.projectId, "npm", NPM, 0);
    const masterKey = randomBytes(32);
    await new SecretVault({ db, masterKey }).set(a.orgId, "t", { name: "NPM_TOKEN" }, TOKEN_NPM, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
    });
    vault = new SecretVault({ db, masterKey, lane: "release" });
    await db.orm
      .update(s.runs)
      .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
      .where(eq(s.runs.id, a.runId));
    proxy = await startProxy();
  });
  afterEach(async () => {
    await proxy?.stop();
    await clearFreeze(db, a.scope).catch(() => {});
    attest.close();
  });

  test("a run the lane never signed gets nothing", async () => {
    expect(await reg()).toEqual({ ok: false, reason: "not_approved" });
    expect(await outcomes()).toContain("release_proxy_register:refused:not_approved");
  });

  test("a signed release gets the project's compat rules, from the lane's own file", async () => {
    await sign();
    const r = await reg();
    expect(r).toMatchObject({ ok: true, rules: ["npm:npm"] });
    expect(await outcomes()).toContain("release_proxy_register:ok");
    expect(proxy!.active).toBe(1);
  });

  test("refused when the tag moved, the repo pin changed, a freeze is on, or nothing is compat", async () => {
    await sign();
    tagSha = "c".repeat(40);
    expect(await reg("a1")).toEqual({ ok: false, reason: "tag_moved" });
    tagSha = SHA;
    attest.pinRepo(a.orgId, a.projectId, "acme/other", 0);
    expect(await reg("a2")).toEqual({ ok: false, reason: "repo_mismatch" });
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    await setFreeze(db, a.scope, { by: "t", reason: "incident", now: 1 });
    expect(await reg("a3")).toEqual({ ok: false, reason: "frozen" });
    await clearFreeze(db, a.scope);
    attest.removePublishTarget(a.orgId, a.projectId, "npm");
    attest.setPublishTarget(
      a.orgId,
      a.projectId,
      "npm",
      { ...NPM, mode: "strict" } as PublishTarget,
      0,
    );
    expect(await reg("a4")).toEqual({ ok: false, reason: "no_compat_targets" });
    expect(proxy!.active).toBe(0);
  });

  test("a job publishes the approved tarball through the proxy and never holds the token", async () => {
    await sign();
    const r = await reg();
    if (!r.ok) throw new Error("not registered");
    const body = JSON.stringify({
      name: "@acme/web",
      versions: { "1.0.0": { dist: { integrity: integrityOf(npmTar) } } },
      _attachments: { "a.tgz": { data: Buffer.from(npmTar).toString("base64") } },
    });
    const viaProxy = (b: string) =>
      fetch("https://registry.npmjs.org/@acme%2Fweb", {
        method: "PUT",
        body: b,
        headers: { "content-type": "application/json" },
        proxy: r.credential.proxyUrl(r.listen.host, r.listen.port),
        tls: { ca: r.credential.caPem },
      });
    const ok = await viaProxy(body);
    expect(ok.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN_NPM}`);
    expect(seen[0]!.url).toBe("https://registry.npmjs.org/@acme%2Fweb");
    // other bytes under the same name are refused and never sent
    const evil = await tarball({ name: "@acme/web", version: "1.0.0", evil: true });
    const bad = await viaProxy(
      JSON.stringify({
        name: "@acme/web",
        versions: { "1.0.0": { dist: { integrity: integrityOf(evil) } } },
        _attachments: { "a.tgz": { data: Buffer.from(evil).toString("base64") } },
      }),
    );
    expect(bad.status).toBe(403);
    expect(seen).toHaveLength(1);
    const log = await outcomes();
    expect(log).toContain("secret_use:ok");
    expect(log).toContain("proxy_deny:body_digest_not_approved");
    expect(JSON.stringify(await chainedAudit(db, a.orgId, 0, 500))).not.toContain(TOKEN_NPM);
    expect(checkBody({ type: "sha256", digests: [sha256("x")] }, Buffer.from("x"))).toEqual({
      ok: true,
    });
  });

  test("a freeze refuses the next request and sweepFrozen ends the credential", async () => {
    await sign();
    const r = await reg();
    if (!r.ok) throw new Error("not registered");
    await setFreeze(db, a.scope, { by: "t", reason: "incident", now: 1 });
    const res = await fetch("https://registry.npmjs.org/@acme%2Fweb", {
      proxy: r.credential.proxyUrl(r.listen.host, r.listen.port),
      tls: { ca: r.credential.caPem },
    });
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(0);
    expect(await proxy!.sweepFrozen()).toBe(1);
    expect(proxy!.active).toBe(0);
    expect(await outcomes()).toContain("release_proxy_revoke:frozen");
  });
});

describe("finishing a compat release", () => {
  let db: Db;
  let a: Tenant;
  let attest: AttestationStore;
  let npmTar: Uint8Array;
  let versions: Map<string, string>;
  let puts: number;
  const reply = (status: number, body: unknown = {}): Response => Response.json(body, { status });
  const fakeFetch: SafeFetch = async (input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const v = Object.fromEntries([...versions].map(([k, i]) => [k, { dist: { integrity: i } }]));
      return versions.size === 0 ? reply(404) : reply(200, { versions: v });
    }
    puts += 1;
    const doc = JSON.parse(String(init?.body)) as {
      versions: Record<string, { dist: { integrity: string } }>;
    };
    for (const [v, m] of Object.entries(doc.versions)) versions.set(v, m.dist.integrity);
    return reply(201);
  };
  const lane = (): ReleaseLane =>
    new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
      bytes: { read: async (_r, n) => (n === "web-1.0.0.tgz" ? npmTar : undefined) },
      records: {
        async recorded(_s, _r, names) {
          return names.map((n) => ({ name: n, sha256: sha256(npmTar) }));
        },
      },
      attest,
      signer: {
        async signRelease(_s, req) {
          return {
            ok: true,
            envelope: {},
            keyid: "k",
            subjects: req.verified.subjects.map((x) => ({ ...x })),
          };
        },
      },
      publish: {
        credentials: { secret: async () => TOKEN_NPM, githubToken: async () => undefined },
        fetch: fakeFetch,
        npmRegistry: "https://registry.test",
      },
      owner: "lane-1",
      now: () => 1_800_000_000_000,
    });

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    npmTar = await tarball({ name: "@acme/web", version: "1.0.0" });
    versions = new Map();
    puts = 0;
    attest = new AttestationStore(":memory:");
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    attest.setPublishTarget(a.orgId, a.projectId, "npm", NPM, 0);
    await db.orm
      .update(s.runs)
      .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
      .where(eq(s.runs.id, a.runId));
    await createReleaseRequest(db, a.scope, {
      runId: a.runId,
      tag: "v1.0.0",
      artifacts: ["web-1.0.0.tgz"],
      requestedBy: "t",
    });
  });
  afterEach(() => attest.close());

  test("signing a compat target publishes nothing; it waits for the job", async () => {
    await lane().processNext();
    expect(puts).toBe(0);
    expect(attest.publishState({ ...a.scope, repo: "acme/web", tag: "v1.0.0" }, "npm")?.state).toBe(
      "pending",
    );
  });

  test("when the job published the approved bytes the target is already done; otherwise the lane publishes", async () => {
    const l = lane();
    await l.processNext();
    versions.set("1.0.0", integrityOf(npmTar));
    expect(await l.finalize({ ...a.scope, runId: a.runId })).toMatchObject([
      { target: "npm", state: "already" },
    ]);
    expect(puts).toBe(0);

    attest.setPublishState(
      { ...a.scope, repo: "acme/web", tag: "v1.0.0" },
      "npm",
      "pending",
      null,
      0,
    );
    versions.clear();
    expect(await l.finalize({ ...a.scope, runId: a.runId })).toMatchObject([
      { target: "npm", state: "published" },
    ]);
    expect(puts).toBe(1);
  });

  test("a version with other bytes under the name is refused, never accepted", async () => {
    const l = lane();
    await l.processNext();
    versions.set("1.0.0", "sha512-not-ours");
    expect(await l.finalize({ ...a.scope, runId: a.runId })).toMatchObject([
      { state: "refused", reason: "republish_mismatch" },
    ]);
  });

  test("nothing without the lane's own approval, and nothing while the tag has moved", async () => {
    expect(await lane().finalize({ ...a.scope, runId: a.runId })).toMatchObject([
      { reason: "not_approved" },
    ]);
  });
});
