import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tarDirectory } from "@longshore/act-runner";
import type { SafeFetch } from "@longshore/net";
import {
  chainedAudit,
  clearFreeze,
  createReleaseRequest,
  getReleaseRequest,
  setFreeze,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import { AttestationStore } from "../src/release/attest";
import { ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import { integrityOf } from "../src/release/publish/npm";
import { tarEntry } from "../src/release/publish/tar";
import type { PublishCredentials, PublishWiring } from "../src/release/publish/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const SHA = "a".repeat(40);
const TOKEN_NPM = ["npm", "publish", "token", "5f2c91"].join("_");
const TOKEN_GH = ["gh", "write", "token", "8a41e0"].join("_");
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const tmp = mkdtempSync(join(tmpdir(), "ls-publish-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** An `npm pack` stand-in: a gzipped tar with package/package.json. */
async function tarball(pkg: Record<string, unknown>): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(join(d, "package", "package.json"), JSON.stringify(pkg));
  writeFileSync(join(d, "package", "index.js"), "module.exports = 1;\n");
  return tarDirectory(d, ["package"]);
}

let db: Db;
let a: Tenant;
let attest: AttestationStore;
let blobs: Map<string, Uint8Array>;
let signed = 0;
let onSign: () => Promise<void> | void = () => {};
let secretCalls: { name: string; destination: string; tag: string }[];
let secretsAvailable = true;
let githubAvailable = true;

const signer: ReleaseSigner = {
  async signRelease(_scope, req) {
    signed += 1;
    await onSign();
    return {
      ok: true,
      envelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: "eA==",
        signatures: [{ keyid: "k1", sig: "eQ==" }],
      },
      keyid: "k1",
      subjects: req.verified.subjects.map((x) => ({ ...x })),
    };
  },
};

const credentials: PublishCredentials = {
  async secret(_scope, name, destination, tag) {
    secretCalls.push({ name, destination, tag });
    return secretsAvailable ? TOKEN_NPM : undefined;
  },
  async githubToken() {
    return githubAvailable ? TOKEN_GH : undefined;
  },
};

// ---- a fake npm registry and a fake GitHub, as SafeFetch ----
interface Req {
  method: string;
  url: string;
  auth: string;
  body: string;
}
let reqs: Req[];
let npmVersions: Map<string, string>; // version -> integrity ("" = absent)
let npmPutStatus: number;
let npmGetStatus: number;
let gh: {
  release:
    | { id: number; draft: boolean; assets: Map<number, { name: string; bytes: Uint8Array }> }
    | undefined;
  nextId: number;
  uploadStatus: number;
  corruptUploads: boolean;
  patchStatus: number;
};

const reply = (status: number, body: unknown = {}): Response =>
  status === 204 ? new Response(null, { status }) : Response.json(body, { status });

const fakeFetch: SafeFetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const rawBody = init?.body;
  const bodyText =
    typeof rawBody === "string"
      ? rawBody
      : rawBody
        ? `<${(rawBody as Uint8Array).length} bytes>`
        : "";
  reqs.push({ method, url, auth: headers.get("authorization") ?? "", body: bodyText });
  const u = new URL(url);

  if (u.hostname === "registry.test") {
    if (method === "GET") {
      if (npmGetStatus !== 200) return reply(npmGetStatus);
      const versions = Object.fromEntries(
        [...npmVersions].filter(([, i]) => i).map(([v, i]) => [v, { dist: { integrity: i } }]),
      );
      return Object.keys(versions).length === 0 ? reply(404) : reply(200, { versions });
    }
    if (method === "PUT") {
      if (npmPutStatus === 200 || npmPutStatus === 201) {
        const doc = JSON.parse(bodyText) as {
          versions: Record<string, { dist: { integrity: string } }>;
        };
        for (const [v, m] of Object.entries(doc.versions)) npmVersions.set(v, m.dist.integrity);
      }
      return reply(npmPutStatus);
    }
  }
  if (u.hostname === "api.gh.test" || u.hostname === "up.gh.test") {
    const m =
      /^\/repos\/[^/]+\/[^/]+\/releases(?:\/tags\/([^/]+)|\/assets\/(\d+)|\/(\d+)\/assets|\/(\d+))?$/.exec(
        u.pathname,
      );
    if (!m) return reply(404);
    const [, tagName, assetId, uploadFor, relId] = m;
    if (method === "GET" && tagName) {
      if (!gh.release) return reply(404);
      return reply(200, {
        id: gh.release.id,
        draft: gh.release.draft,
        assets: [...gh.release.assets].map(([id, x]) => ({ id, name: x.name })),
      });
    }
    if (method === "POST" && !tagName && !assetId && !uploadFor && !relId) {
      const b = JSON.parse(bodyText) as { draft: boolean };
      gh.release = { id: ++gh.nextId, draft: b.draft, assets: new Map() };
      return reply(201, { id: gh.release.id, draft: gh.release.draft, assets: [] });
    }
    if (method === "POST" && uploadFor) {
      if (gh.uploadStatus !== 201) return reply(gh.uploadStatus);
      const bytes = rawBody as Uint8Array;
      const stored = gh.corruptUploads ? new Uint8Array([...bytes.slice(0, -1), 0]) : bytes;
      gh.release!.assets.set(++gh.nextId, { name: u.searchParams.get("name")!, bytes: stored });
      return reply(201, {});
    }
    if (method === "GET" && assetId) {
      const x = gh.release?.assets.get(Number(assetId));
      return x ? new Response(x.bytes, { status: 200 }) : reply(404);
    }
    if (method === "DELETE" && assetId) {
      gh.release?.assets.delete(Number(assetId));
      return reply(204);
    }
    if (method === "PATCH" && relId) {
      if (gh.patchStatus !== 200) return reply(gh.patchStatus);
      gh.release!.draft = (JSON.parse(bodyText) as { draft: boolean }).draft;
      return reply(200, {});
    }
  }
  return reply(404);
};

const wiring = (over: Partial<PublishWiring> = {}): PublishWiring => ({
  credentials,
  fetch: fakeFetch,
  npmRegistry: "https://registry.test",
  githubApi: "https://api.gh.test",
  githubUploads: "https://up.gh.test",
  ...over,
});

let lane: ReleaseLane;
const makeLane = (w: PublishWiring | null = wiring()) =>
  new ReleaseLane({
    db,
    forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
    bytes: { read: async (_run, name) => blobs.get(name) },
    records: {
      async recorded(_scope, _run, names) {
        return names.flatMap((n) =>
          blobs.has(n) ? [{ name: n, sha256: sha256(blobs.get(n)!) }] : [],
        );
      },
    },
    attest,
    signer,
    ...(w ? { publish: w } : {}),
    owner: "lane-1",
    now: () => 1_800_000_000_000,
  });

const PKG = { name: "@acme/web", version: "1.0.0", description: "a package" };
let npmTar: Uint8Array;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  resetFailureThrottle();
  npmTar = await tarball(PKG);
  blobs = new Map<string, Uint8Array>([
    ["web-1.0.0.tgz", npmTar],
    ["cli-linux", new TextEncoder().encode("linux binary")],
    ["cli-darwin", new TextEncoder().encode("darwin binary")],
  ]);
  signed = 0;
  onSign = () => {};
  secretCalls = [];
  secretsAvailable = true;
  githubAvailable = true;
  reqs = [];
  npmVersions = new Map();
  npmPutStatus = 201;
  npmGetStatus = 200;
  gh = {
    release: undefined,
    nextId: 100,
    uploadStatus: 201,
    corruptUploads: false,
    patchStatus: 200,
  };
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
  lane = makeLane();
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
});
afterEach(async () => {
  await clearFreeze(db, a.scope).catch(() => {});
  attest.close();
});

const NPM = {
  kind: "npm" as const,
  mode: "strict" as const,
  package: "@acme/web",
  artifact: "web-1.0.0.tgz",
  tag: "latest",
  access: "public" as const,
  secret: "NPM_TOKEN",
};
const GH = {
  kind: "github-release" as const,
  mode: "strict" as const,
  assets: ["cli-linux", "cli-darwin"],
  provenanceAsset: "provenance.intoto.json" as string | null,
};
const declare = (key: string, t: typeof NPM | typeof GH): void =>
  attest.setPublishTarget(a.orgId, a.projectId, key, t, 0);

async function run(artifacts = ["web-1.0.0.tgz", "cli-linux", "cli-darwin"], tag = "v1.0.0") {
  const r = await createReleaseRequest(db, a.scope, {
    runId: a.runId,
    tag,
    artifacts,
    requestedBy: "test",
  });
  expect(await lane.processNext()).toBe(true);
  const row = (await getReleaseRequest(db, a.scope, r.id))!;
  const published =
    (
      JSON.parse(row.result ?? "{}") as {
        published?: { target: string; state: string; reason?: string }[];
      }
    ).published ?? [];
  return { row, published };
}
const registryCalls = () => reqs.filter((r) => r.url.includes("registry.test"));
const ghCalls = () => reqs.filter((r) => r.url.includes("gh.test"));
const audits = async () =>
  (await chainedAudit(db, a.orgId, 0, 500)).filter((r) => r.op === "release_lane");

describe("npm: the lane publishes the tarball it verified", () => {
  test("the request is what npm publish would send, built from the verified bytes, with the lane's token", async () => {
    declare("npm", NPM);
    const { row, published } = await run();
    expect(row.status).toBe("signed");
    expect(published).toMatchObject([{ target: "npm", state: "published" }]);
    const put = registryCalls().find((r) => r.method === "PUT")!;
    expect(put.url).toBe("https://registry.test/@acme%2Fweb");
    expect(put.auth).toBe(`Bearer ${TOKEN_NPM}`);
    const doc = JSON.parse(put.body) as Record<string, any>;
    expect(doc.name).toBe("@acme/web");
    expect(doc["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(doc.access).toBe("public");
    const v = doc.versions["1.0.0"];
    expect(v.dist.integrity).toBe(integrityOf(npmTar));
    expect(v.dist.shasum).toBe(createHash("sha1").update(npmTar).digest("hex"));
    const att = doc._attachments["@acme/web-1.0.0.tgz"];
    expect(Buffer.from(att.data, "base64").equals(Buffer.from(npmTar))).toBe(true);
    // the secret was asked for by name, for the registry host, for this tag
    expect(secretCalls).toEqual([
      { name: "NPM_TOKEN", destination: "registry.test", tag: "v1.0.0" },
    ]);
  });

  test("the token is nowhere in what is stored or audited", async () => {
    declare("npm", NPM);
    const { row } = await run();
    const everything = JSON.stringify({ row, audit: await chainedAudit(db, a.orgId, 0, 500) });
    expect(everything).not.toContain(TOKEN_NPM);
    expect((await audits()).map((r) => r.outcome)).toContain("publish:npm:published");
  });

  test("a version that exists with the same bytes is already published: no PUT; with other bytes, a refusal", async () => {
    declare("npm", NPM);
    npmVersions.set("1.0.0", integrityOf(npmTar));
    const same = await run();
    expect(same.published).toMatchObject([{ target: "npm", state: "already" }]);
    expect(registryCalls().some((r) => r.method === "PUT")).toBe(false);

    attest.setPublishState(
      { orgId: a.orgId, projectId: a.projectId, repo: "acme/web", tag: "v1.0.0" },
      "npm",
      "failed",
      null,
      0,
    );
    npmVersions.set("1.0.0", "sha512-someone-elses-bytes");
    // a different tag keeps the attested digests of this one apart, so ask again under the same tag
    const other = await run();
    expect(other.published[0]).toMatchObject({ state: "refused", reason: "republish_mismatch" });
    expect(registryCalls().some((r) => r.method === "PUT")).toBe(false);
  });

  test.each([
    ["the tarball is another package", { ...PKG, name: "@acme/other" }, "package_mismatch"],
    ["the version is not the tag's", { ...PKG, version: "1.0.1" }, "version_tag_mismatch"],
    ["the package is private", { ...PKG, private: true }, "private_package"],
    ["the version is not semver", { ...PKG, version: "latest" }, "bad_version"],
  ])("refused before any request when %s", async (_why, pkg, reason) => {
    const t = await tarball(pkg);
    blobs.set("web-1.0.0.tgz", t);
    declare("npm", NPM);
    const { published } = await run();
    expect(published[0]).toMatchObject({ target: "npm", state: "refused", reason });
    expect(reqs).toEqual([]);
  });

  test("an artifact that is not an npm tarball is refused", async () => {
    blobs.set("web-1.0.0.tgz", new TextEncoder().encode("not a tarball"));
    declare("npm", NPM);
    const { published } = await run();
    expect(published[0]).toMatchObject({ state: "refused", reason: "not_an_npm_tarball" });
    expect(reqs).toEqual([]);
  });

  test("bytes that change between the lane's check and the publish are refused", async () => {
    declare("npm", NPM);
    let reads = 0;
    lane = new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
      bytes: {
        read: async (_run, name) => {
          const b = blobs.get(name)!;
          if (name !== "web-1.0.0.tgz") return b;
          reads += 1;
          // the first read verifies; any later one (the publisher's) sees other bytes
          return reads > 1 ? await tarball({ ...PKG, description: "swapped" }) : b;
        },
      },
      records: {
        async recorded(_s, _r, names) {
          return names.map((n) => ({ name: n, sha256: sha256(blobs.get(n)!) }));
        },
      },
      attest,
      signer,
      publish: wiring(),
      owner: "lane-1",
      now: () => 1_800_000_000_000,
    });
    const { published } = await run(["web-1.0.0.tgz"]);
    expect(published[0]).toMatchObject({ state: "refused", reason: "digest_mismatch" });
    expect(reqs).toEqual([]);
  });

  test("a registry error is a failed target; asking again resumes and publishes", async () => {
    declare("npm", NPM);
    npmPutStatus = 403;
    const first = await run();
    expect(first.row.status).toBe("signed");
    expect(first.published[0]).toMatchObject({ state: "failed", reason: "http_403" });
    npmPutStatus = 201;
    const second = await run();
    expect(second.published[0]).toMatchObject({ state: "published" });
  });

  test("a 409 from a concurrent publish of the same bytes is already published", async () => {
    declare("npm", NPM);
    npmPutStatus = 409;
    const origPut = npmVersions;
    void origPut;
    const f: SafeFetch = async (input, init) => {
      const res = await fakeFetch(input, init);
      // after the 409 the version is there, with our bytes
      if ((init?.method ?? "GET") === "PUT") npmVersions.set("1.0.0", integrityOf(npmTar));
      return res;
    };
    lane = makeLane(wiring({ fetch: f }));
    const { published } = await run();
    expect(published[0]).toMatchObject({ state: "already" });
  });

  test("a secret the vault will not give fails the target, and the registry is never asked", async () => {
    declare("npm", NPM);
    secretsAvailable = false;
    const { published } = await run();
    expect(published[0]).toMatchObject({ state: "failed", reason: "credential_unavailable" });
    expect(reqs).toEqual([]);
  });

  test("a target naming an artifact the request did not ask for is refused", async () => {
    declare("npm", NPM);
    const { published } = await run(["cli-linux"]);
    expect(published[0]).toMatchObject({ state: "refused", reason: "artifact_not_requested" });
    expect(reqs).toEqual([]);
  });

  test("a target that finished is not repeated by a second request for the tag", async () => {
    declare("npm", NPM);
    await run();
    const before = reqs.length;
    const again = await run();
    expect(again.published[0]).toMatchObject({ state: "already", reason: "recorded" });
    expect(reqs.length).toBe(before);
  });
});

describe("GitHub Releases: draft, upload, verify, then publish", () => {
  test("creates a draft, attaches the verified bytes and the provenance, verifies, publishes", async () => {
    declare("release", GH);
    const { published } = await run();
    expect(published).toMatchObject([{ target: "release", state: "published" }]);
    const calls = ghCalls().map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(
      calls.filter((c) => c.startsWith("POST /repos/acme/web/releases")).length,
    ).toBeGreaterThan(0);
    const created = ghCalls().find((r) => r.method === "POST" && r.url.endsWith("/releases"))!;
    expect(JSON.parse(created.body)).toMatchObject({
      tag_name: "v1.0.0",
      draft: true,
      prerelease: false,
    });
    // the draft is published only after every asset was read back
    const patchAt = calls.findIndex((c) => c.startsWith("PATCH"));
    const lastDownload = calls
      .map((c, i) => (c.includes("/releases/assets/") ? i : -1))
      .filter((i) => i >= 0)
      .at(-1)!;
    expect(patchAt).toBeGreaterThan(lastDownload);
    expect(gh.release!.draft).toBe(false);
    const held = new Map([...gh.release!.assets.values()].map((x) => [x.name, x.bytes]));
    expect([...held.keys()].sort()).toEqual(["cli-darwin", "cli-linux", "provenance.intoto.json"]);
    expect(new TextDecoder().decode(held.get("cli-linux")!)).toBe("linux binary");
    // the write credential travelled only to GitHub's hosts, as the lane's own
    for (const r of ghCalls()) expect(r.auth).toBe(`Bearer ${TOKEN_GH}`);
  });

  test("a prerelease tag makes a prerelease", async () => {
    declare("release", GH);
    await createReleaseRequest(db, a.scope, {
      runId: a.runId,
      tag: "v1.0.0-alpha.1",
      artifacts: ["cli-linux", "cli-darwin"],
      requestedBy: "t",
    });
    await db.orm
      .update(s.runs)
      .set({ ref: "refs/tags/v1.0.0-alpha.1" })
      .where(eq(s.runs.id, a.runId));
    expect(await lane.processNext()).toBe(true);
    const created = ghCalls().find((r) => r.method === "POST" && r.url.endsWith("/releases"))!;
    expect(JSON.parse(created.body).prerelease).toBe(true);
  });

  test("a published release that matches is left alone; one that differs is refused and never modified", async () => {
    declare("release", GH);
    gh.release = {
      id: 7,
      draft: false,
      assets: new Map([
        [1, { name: "cli-linux", bytes: new TextEncoder().encode("linux binary") }],
        [2, { name: "cli-darwin", bytes: new TextEncoder().encode("darwin binary") }],
        [
          3,
          {
            name: "provenance.intoto.json",
            bytes: new TextEncoder().encode(
              JSON.stringify({
                payloadType: "application/vnd.in-toto+json",
                payload: "eA==",
                signatures: [{ keyid: "k1", sig: "eQ==" }],
              }),
            ),
          },
        ],
      ]),
    };
    const same = await run();
    expect(same.published[0]).toMatchObject({ state: "already" });
    expect(ghCalls().every((r) => r.method === "GET")).toBe(true);

    gh.release.assets.set(1, { name: "cli-linux", bytes: new TextEncoder().encode("tampered") });
    attest.setPublishState(
      { orgId: a.orgId, projectId: a.projectId, repo: "acme/web", tag: "v1.0.0" },
      "release",
      "failed",
      null,
      0,
    );
    reqs = [];
    const other = await run();
    expect(other.published[0]).toMatchObject({ state: "refused", reason: "republish_mismatch" });
    expect(reqs.every((r) => r.method === "GET")).toBe(true);
  });

  test("a draft that already holds a matching asset keeps it, and one holding other bytes has it replaced", async () => {
    declare("release", GH);
    gh.release = {
      id: 7,
      draft: true,
      assets: new Map([
        [1, { name: "cli-linux", bytes: new TextEncoder().encode("linux binary") }],
        [2, { name: "cli-darwin", bytes: new TextEncoder().encode("stale") }],
      ]),
    };
    const { published } = await run();
    expect(published[0]).toMatchObject({ state: "published" });
    const uploads = ghCalls().filter((r) => r.method === "POST" && r.url.includes("up.gh.test"));
    expect(uploads.map((r) => new URL(r.url).searchParams.get("name")).sort()).toEqual([
      "cli-darwin",
      "provenance.intoto.json",
    ]);
    expect(ghCalls().filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(gh.release!.draft).toBe(false);
  });

  test("if GitHub does not hold what was uploaded, the draft is never published", async () => {
    declare("release", GH);
    gh.corruptUploads = true;
    const { published } = await run();
    expect(published[0]).toMatchObject({ state: "refused", reason: "verify_failed" });
    expect(ghCalls().some((r) => r.method === "PATCH")).toBe(false);
    expect(gh.release!.draft).toBe(true);
  });

  test("an upload or publish failure is a failed target and the release stays a draft", async () => {
    declare("release", GH);
    gh.uploadStatus = 500;
    expect((await run()).published[0]).toMatchObject({ state: "failed", reason: "http_500" });
    expect(gh.release!.draft).toBe(true);
    gh.uploadStatus = 201;
    gh.patchStatus = 422;
    expect((await run()).published[0]).toMatchObject({ state: "failed", reason: "http_422" });
    expect(gh.release!.draft).toBe(true);
    gh.patchStatus = 200;
    expect((await run()).published[0]).toMatchObject({ state: "published" });
  });

  test("with provenance off, no provenance asset is attached; no GitHub credential fails the target", async () => {
    declare("release", { ...GH, provenanceAsset: null });
    await run();
    expect([...gh.release!.assets.values()].map((x) => x.name).sort()).toEqual([
      "cli-darwin",
      "cli-linux",
    ]);
    gh.release = undefined;
    githubAvailable = false;
    attest.setPublishState(
      { orgId: a.orgId, projectId: a.projectId, repo: "acme/web", tag: "v1.0.0" },
      "release",
      "failed",
      null,
      0,
    );
    reqs = [];
    expect((await run()).published[0]).toMatchObject({
      state: "failed",
      reason: "credential_unavailable",
    });
    expect(reqs).toEqual([]);
  });
});

describe("what governs every target", () => {
  test("no declaration, or no publish wiring, publishes nothing and changes nothing about signing", async () => {
    const none = await run();
    expect(none.row.status).toBe("signed");
    expect(none.published).toEqual([]);
    declare("npm", NPM);
    lane = makeLane(null);
    const unwired = await run();
    expect(unwired.published).toEqual([]);
    expect(reqs).toEqual([]);
  });

  test("an incident freeze that lands after signing stops publishing, target by target", async () => {
    declare("npm", NPM);
    declare("release", GH);
    onSign = async () => {
      await setFreeze(db, a.scope, { by: "test", reason: "incident", now: 1 });
    };
    const { row, published } = await run();
    expect(row.status).toBe("signed");
    expect(published.map((p) => p.reason)).toEqual(["frozen", "frozen"]);
    expect(reqs).toEqual([]);
  });

  test("targets run in key order and each is recorded and audited", async () => {
    declare("release", GH);
    declare("npm", NPM);
    const { published } = await run();
    expect(published.map((p) => p.target)).toEqual(["npm", "release"]);
    const outcomes = (await audits()).map((r) => r.outcome);
    expect(outcomes).toContain("publish:npm:published");
    expect(outcomes).toContain("publish:release:published");
    expect(
      attest.publishState(
        { orgId: a.orgId, projectId: a.projectId, repo: "acme/web", tag: "v1.0.0" },
        "npm",
      )?.state,
    ).toBe("published");
  });

  test("a bad declaration in the lane's file publishes nothing", async () => {
    // written straight into the file, bypassing the CLI's checks
    (attest as unknown as { setPublishTarget(...a: unknown[]): void }).setPublishTarget(
      a.orgId,
      a.projectId,
      "npm",
      {
        kind: "npm",
        package: "../evil",
        artifact: "web-1.0.0.tgz",
        tag: "latest",
        access: "public",
        secret: "NPM_TOKEN",
      },
      0,
    );
    const { published } = await run();
    expect(published).toEqual([]);
    expect(reqs).toEqual([]);
  });
});

describe("the tarball reader", () => {
  test("reads package/package.json, and nothing it should not", async () => {
    const t = await tarball(PKG);
    expect(JSON.parse(new TextDecoder().decode(tarEntry(t, "package/package.json")!)).name).toBe(
      "@acme/web",
    );
    expect(tarEntry(t, "package/missing.json")).toBeUndefined();
    expect(tarEntry(new TextEncoder().encode("not gzip"), "package/package.json")).toBeUndefined();
    expect(tarEntry(t, "package/package.json", 5)).toBeUndefined();
  });
});

describe("target declarations", () => {
  const ok = { kind: "npm", package: "@acme/web", artifact: "a.tgz", secret: "NPM_TOKEN" };
  test("defaults, and the shapes that are refused", async () => {
    const { parseTarget } = await import("../src/release/publish/config");
    expect(parseTarget(ok)).toMatchObject({ tag: "latest", access: "public" });
    expect(parseTarget({ kind: "github-release", assets: ["a"] })).toMatchObject({
      provenanceAsset: "provenance.intoto.json",
    });
    for (const bad of [
      null,
      { ...ok, package: "../x" },
      { ...ok, artifact: "../a.tgz" },
      { ...ok, tag: "has space" },
      { ...ok, access: "other" },
      { ...ok, secret: "lower case" },
      { kind: "github-release", assets: [] },
      { kind: "github-release", assets: ["a", "a"] },
      { kind: "github-release", assets: ["a"], provenanceAsset: "a" },
      { kind: "pypi" },
    ]) {
      expect(() => parseTarget(bad)).toThrow();
    }
  });
});
