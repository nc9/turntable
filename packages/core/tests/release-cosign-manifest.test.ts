// #544 round 2: the lane verifies a signed manifest of binaries (the acmescan client's shape)
// over the FILES inside the run's artifact zips, publishes every file of an artifact plus the
// co-signature files, publishes npm only after the GitHub release, and can dry-run all of it.
// Every key, signature, zip and tarball here is made at runtime.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tarDirectory } from "@turntable/act-runner";
import type { SafeFetch } from "@turntable/net";
import {
  clearFreeze,
  createReleaseRequest,
  getReleaseRequest,
  listAudit,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { resetFailureThrottle } from "../src/audit/failures";
import { AttestationStore } from "../src/release/attest";
import { cosignFingerprint, cosignKeyId } from "../src/release/cosign";
import { planAssets } from "../src/release/publish/github-release";
import { publishOrder, ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import type { PublishTarget, PublishWiring } from "../src/release/publish/types";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";
import { buildZip } from "./helpers/zip-builder";
import { opsHarness } from "./release-config-helpers";

const SHA = "a".repeat(40);
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const GH_TOKEN = ["gh", "write", "token", "2d9e"].join("_");
const NPM_TOKEN = ["npm", "publish", "token", "77c1"].join("_");
const tmp = mkdtempSync(join(tmpdir(), "tt-cosign-manifest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Pair {
  priv: KeyObject;
  pem: string;
}
const newPair = (): Pair => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { priv: privateKey, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const sigOf = (p: Pair, bytes: Uint8Array): Uint8Array =>
  new Uint8Array(sign("sha256", bytes, { key: p.priv, dsaEncoding: "der" }));

async function tarball(pkg: Record<string, unknown>): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(join(d, "package", "package.json"), JSON.stringify(pkg));
  return tarDirectory(d, ["package"]);
}

// ---- the release: what the acmescan workflow uploads ----
const PLATFORMS = ["linux-x64", "darwin-arm64"] as const;
const binName = (p: string, v = "1.0.0"): string => `acme-${v}-${p}`;

let db: Db;
let a: Tenant;
let attest: AttestationStore;
let pair: Pair;
let blobs: Map<string, Uint8Array>;
let files: Map<string, Uint8Array>; // the files inside release-binaries
let signs = 0;
let lane: ReleaseLane;
let reqs: { method: string; url: string }[];
let gh: {
  release?: {
    id: number;
    draft: boolean;
    assets: Map<number, { name: string; bytes: Uint8Array }>;
  };
  next: number;
  uploadStatus: number;
};
let npmPut: { body: string }[];
let checkKeyResult: { ok: true } | { ok: false; reason: string };

const signer: ReleaseSigner = {
  async checkKey() {
    return checkKeyResult;
  },
  async signRelease(_scope, req) {
    signs += 1;
    return {
      ok: true,
      envelope: { payload: "eA==", signatures: [{ keyid: "k1", sig: "eQ==" }] },
      keyid: "k1",
      subjects: req.verified.subjects.map((x) => ({ ...x })),
    };
  },
};

const reply = (st: number, b: unknown = {}): Response =>
  st === 204 ? new Response(null, { status: st }) : Response.json(b, { status: st });

const fakeFetch: SafeFetch = async (input, init) => {
  const u = new URL(String(input));
  const method = init?.method ?? "GET";
  reqs.push({ method, url: String(input) });
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : "";
  if (u.hostname === "registry.test") {
    if (method === "GET") return reply(404);
    if (method === "PUT") {
      npmPut.push({ body: text });
      return reply(201);
    }
  }
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
    gh.release = { id: ++gh.next, draft: true, assets: new Map() };
    return reply(201, { id: gh.release.id, draft: true, assets: [] });
  }
  if (method === "POST" && uploadFor) {
    if (gh.uploadStatus !== 201) return reply(gh.uploadStatus);
    gh.release!.assets.set(++gh.next, {
      name: u.searchParams.get("name")!,
      bytes: raw as Uint8Array,
    });
    return reply(201);
  }
  if (method === "GET" && assetId) {
    const x = gh.release?.assets.get(Number(assetId));
    return x ? new Response(x.bytes, { status: 200 }) : reply(404);
  }
  if (method === "PATCH" && relId) {
    gh.release!.draft = (JSON.parse(text) as { draft: boolean }).draft;
    return reply(200);
  }
  return reply(404);
};

const wiring: PublishWiring = {
  credentials: {
    secret: async () => NPM_TOKEN,
    githubToken: async () => GH_TOKEN,
  },
  fetch: fakeFetch,
  npmRegistry: "https://registry.test",
  githubApi: "https://api.gh.test",
  githubUploads: "https://up.gh.test",
};

/** The manifest the acmescan client reads, over the release's binaries. */
function manifestBytes(over: Record<string, unknown> = {}): Uint8Array {
  return enc(
    JSON.stringify({
      version: "1.0.0",
      signing_key_id: cosignKeyId(pair.pem),
      binaries: Object.fromEntries(
        PLATFORMS.map((p) => [
          p,
          { filename: binName(p), sha256: sha256(files.get(binName(p)) ?? enc("")) },
        ]),
      ),
      ...over,
    }),
  );
}

/** Rebuilds the artifact zips from `files`; called after a test changes a file. */
function pack(): void {
  blobs.set("release-binaries", buildZip([...files].map(([name, data]) => ({ name, data }))));
}

const GH_TARGET: PublishTarget = {
  kind: "github-release",
  mode: "strict",
  assets: [],
  assetArtifacts: ["release-binaries"],
  provenanceAsset: "provenance.intoto.json",
};
const NPM_TARGET: PublishTarget = {
  kind: "npm",
  mode: "strict",
  package: "acmescan",
  artifact: "npm-package",
  tag: "beta",
  access: "public",
  secret: "NPM_TOKEN",
};

function setKey(over: Record<string, unknown> = {}): void {
  attest.setCosignKey(
    a.orgId,
    a.projectId,
    {
      name: "acme",
      public_key_pem: pair.pem,
      signs: "manifest.json",
      output_name: "manifest.json.sig",
      format: "detached-der-p256-sha256",
      manifest: { shape: "binaries-map" },
      ...over,
    },
    0,
  );
}

type Carried = { name: string; file?: string; signature_b64: string };
/** The co-signatures the client's owner makes over the files as they are now. */
function goodSigs(p: Pair = pair): Carried[] {
  return [
    { name: "acme", signature_b64: b64(sigOf(p, files.get("manifest.json")!)) },
    ...PLATFORMS.map((pl) => ({
      name: "acme",
      file: binName(pl),
      signature_b64: b64(sigOf(p, files.get(binName(pl))!)),
    })),
  ];
}

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  resetFailureThrottle();
  pair = newPair();
  files = new Map<string, Uint8Array>(PLATFORMS.map((p) => [binName(p), enc(`binary ${p}`)]));
  files.set("SHA256SUMS", enc("sums\n"));
  files.set("manifest.json", manifestBytes());
  blobs = new Map();
  pack();
  blobs.set(
    "npm-package",
    buildZip([
      {
        name: "acmescan-1.0.0.tgz",
        data: await tarball({ name: "acmescan", version: "1.0.0" }),
      },
    ]),
  );
  signs = 0;
  reqs = [];
  npmPut = [];
  checkKeyResult = { ok: true };
  gh = { next: 100, uploadStatus: 201 };
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/acme", 0);
  attest.setPublishTarget(a.orgId, a.projectId, "github", GH_TARGET, 0);
  attest.setPublishTarget(a.orgId, a.projectId, "npm", NPM_TARGET, 0);
  setKey();
  lane = new ReleaseLane({
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
    publish: wiring,
    owner: "lane-1",
    now: () => 1_800_000_000_000,
  });
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/acme", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
});
afterEach(async () => {
  await clearFreeze(db, a.scope).catch(() => {});
  attest.close();
});

async function release(
  cosignatures: Carried[] | undefined = goodSigs(),
  o: { dry?: boolean; tag?: string } = {},
) {
  const r = await createReleaseRequest(db, a.scope, {
    runId: a.runId,
    tag: o.tag ?? "v1.0.0",
    artifacts: ["release-binaries", "npm-package"],
    cosignatures,
    ...(o.dry ? { dryRun: true } : {}),
    requestedBy: "test",
  });
  expect(await lane.processNext()).toBe(true);
  const row = (await getReleaseRequest(db, a.scope, r.id))!;
  const result = JSON.parse(row.result ?? "{}") as {
    published?: { target: string; state: string; reason?: string; detail?: string }[];
    plan?: { targets: Record<string, unknown>[]; note?: string };
  };
  return { row, result };
}
const nothingHappened = (): void => {
  expect(signs).toBe(0);
  expect(reqs).toEqual([]);
  expect(gh.release).toBeUndefined();
};
const held = (): string[] => [...(gh.release?.assets.values() ?? [])].map((x) => x.name).toSorted();

describe("the acmescan release, end to end", () => {
  test("the manifest, every binary and the tarball verify; every file of the artifact and every .sig is published, then npm", async () => {
    const sigs = goodSigs();
    const { row, result } = await release(sigs);
    expect(row).toMatchObject({ status: "signed", reason: null });
    expect(signs).toBe(1);
    expect(gh.release?.draft).toBe(false);
    expect(held()).toEqual(
      [
        "SHA256SUMS",
        "manifest.json",
        "manifest.json.sig",
        ...PLATFORMS.map((p) => binName(p)),
        ...PLATFORMS.map((p) => `${binName(p)}.sig`),
        "provenance.intoto.json",
      ].toSorted(),
    );
    // each .sig is the raw DER the owner made over exactly that file, not base64
    const sigFor = (n: string) => [...gh.release!.assets.values()].find((x) => x.name === n)!.bytes;
    expect(
      Buffer.from(sigFor("manifest.json.sig")).equals(
        Buffer.from(sigs[0]!.signature_b64, "base64"),
      ),
    ).toBe(true);
    for (const c of sigs.slice(1)) {
      expect(
        Buffer.from(sigFor(`${c.file}.sig`)).equals(Buffer.from(c.signature_b64, "base64")),
      ).toBe(true);
    }
    expect(result.published?.map((p) => [p.target, p.state])).toEqual([
      ["github", "published"],
      ["npm", "published"],
    ]);
    // npm: the single .tgz of the artifact, under the target's tag
    const put = JSON.parse(npmPut[0]!.body) as { "dist-tags": Record<string, string> };
    expect(put["dist-tags"]).toEqual({ beta: "1.0.0" });
    // and it went out only after the GitHub release was published (the PATCH)
    const order = reqs.map((r) => `${r.method} ${new URL(r.url).hostname}`);
    expect(order.lastIndexOf("PATCH api.gh.test")).toBeLessThan(order.indexOf("PUT registry.test"));
  });

  test("the version is the tag's with or without a leading v", async () => {
    files.set("manifest.json", manifestBytes({ version: "v1.0.0" }));
    pack();
    expect((await release()).row.status).toBe("signed");
  });

  test("the lane reports each verified signature by fingerprint, with the binary it covers", async () => {
    const { row } = await release();
    const facts = JSON.parse(row.facts!) as {
      cosignatures: { name: string; file?: string; status: string; key_id?: string }[];
    };
    expect(facts.cosignatures).toHaveLength(1 + PLATFORMS.length);
    expect(facts.cosignatures.every((c) => c.status === "verified")).toBe(true);
    expect(facts.cosignatures.every((c) => c.key_id === cosignKeyId(pair.pem))).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("BEGIN PUBLIC KEY");
  });
});

describe("the lane refuses, signs nothing and publishes nothing", () => {
  const refused = async (
    reason: string,
    detail: RegExp | string,
    cosignatures?: Carried[],
  ): Promise<void> => {
    const { row } = await release(cosignatures);
    expect(row).toMatchObject({ status: "refused", reason });
    expect(row.detail).toMatch(detail);
    nothingHappened();
  };

  test("a binary with no signature of its own", async () => {
    await refused(
      "cosign_missing",
      /must co-sign acme-1.0.0-darwin-arm64/,
      goodSigs().filter((c) => c.file !== binName("darwin-arm64")),
    );
  });

  test("a binary signed by another key", async () => {
    const other = newPair();
    const sigs = goodSigs();
    sigs[1] = { ...sigs[1]!, signature_b64: b64(sigOf(other, files.get(binName("linux-x64"))!)) };
    await refused("signature_invalid", /acme-1.0.0-linux-x64/, sigs);
  });

  test("a signature over a binary that is not the one in the release", async () => {
    const sigs = goodSigs();
    sigs[1] = { ...sigs[1]!, signature_b64: b64(sigOf(pair, enc("another build"))) };
    await refused("signature_invalid", /acme-1.0.0-linux-x64/, sigs);
  });

  test("the manifest signed by another key", async () => {
    await refused("signature_invalid", /manifest.json/, goodSigs(newPair()));
  });

  test("a manifest whose signing_key_id is not the pinned key's", async () => {
    files.set("manifest.json", manifestBytes({ signing_key_id: "0123456789abcdef" }));
    pack();
    await refused("cosign_manifest_check", /signing_key_id/, goodSigs());
  });

  test("a manifest version that is not the tag", async () => {
    files.set("manifest.json", manifestBytes({ version: "1.0.1" }));
    pack();
    await refused("cosign_manifest_check", /version does not match the tag/, goodSigs());
  });

  test("a manifest sha256 that is not the file's, or not lowercase hex", async () => {
    const m = JSON.parse(new TextDecoder().decode(manifestBytes())) as {
      binaries: Record<string, { filename: string; sha256: string }>;
    };
    m.binaries["linux-x64"]!.sha256 = sha256("other");
    files.set("manifest.json", enc(JSON.stringify(m)));
    pack();
    await refused("cosign_manifest_check", /differs from the bytes the lane publishes/, goodSigs());

    m.binaries["linux-x64"]!.sha256 = sha256(files.get(binName("linux-x64"))!).toUpperCase();
    files.set("manifest.json", enc(JSON.stringify(m)));
    pack();
    await refused("cosign_manifest_check", /lowercase hex/, goodSigs());
  });

  test("a binary the manifest lists that is not in the release", async () => {
    const sigs = goodSigs();
    files.delete(binName("darwin-arm64"));
    pack();
    await refused("cosign_manifest_check", /not a file of this release/, sigs);
  });

  test("an extra binary in the artifact that the manifest does not list", async () => {
    files.set("acme-1.0.0-windows-x64.exe", enc("unsigned"));
    pack();
    await refused("cosign_manifest_check", /windows-x64.exe.*unsigned/, goodSigs());
  });

  test("a signature for a file the manifest does not list", async () => {
    await refused("cosign_unexpected", /SHA256SUMS/, [
      ...goodSigs(),
      {
        name: "acme",
        file: "SHA256SUMS",
        signature_b64: b64(sigOf(pair, files.get("SHA256SUMS")!)),
      },
    ]);
  });

  test("a manifest whose binaries is a list, or is empty, or names a file twice", async () => {
    files.set("manifest.json", manifestBytes({ binaries: [{ filename: "x", sha256: "0" }] }));
    pack();
    await refused("cosign_manifest_check", /non-empty map/, goodSigs());
    files.set("manifest.json", manifestBytes({ binaries: {} }));
    pack();
    await refused("cosign_manifest_check", /non-empty map/, goodSigs());
    const one = {
      filename: binName("linux-x64"),
      sha256: sha256(files.get(binName("linux-x64"))!),
    };
    files.set(
      "manifest.json",
      manifestBytes({ binaries: { "linux-x64": one, "linux-x64-b": one } }),
    );
    pack();
    await refused("cosign_manifest_check", /listed twice/, goodSigs());
  });

  test("a binary signature given for a key that signs one file only", async () => {
    setKey({ manifest: undefined });
    await refused("cosign_unexpected", /signs one file/, goodSigs());
  });

  test("a signature asset name that another file of the artifact already has", async () => {
    files.set(`${binName("linux-x64")}.sig`, enc("sneaky"));
    pack();
    await refused("cosign_manifest_check", /not a usable signature asset name/, goodSigs());
  });
});

describe("publishing every file of an artifact", () => {
  const ctx = (filesOf: Record<string, string[]>, cos: string[] = []) => ({
    filesOf: (x: string) => filesOf[x] ?? [],
    cosignatures: cos.map((outputName) => ({ outputName, signature: new Uint8Array() })),
  });
  const gh2 = (over: Partial<Extract<PublishTarget, { kind: "github-release" }>>) =>
    ({ ...GH_TARGET, ...over }) as Extract<PublishTarget, { kind: "github-release" }>;

  test("each file goes under its own basename; the existing assets list keeps working beside it", () => {
    const p = planAssets(
      gh2({ assets: ["tool.txt"], assetArtifacts: ["bins"] }),
      ctx({ bins: ["dist/a", "b"] }, ["a.sig"]),
      true,
    );
    expect(p).toEqual({
      ok: true,
      assets: [
        { asset: "tool.txt", file: "tool.txt" },
        { asset: "a", file: "dist/a" },
        { asset: "b", file: "b" },
        { asset: "provenance.intoto.json" },
        { asset: "a.sig" },
      ],
    });
  });

  test("a collision (two paths with one basename, an asset, the provenance or a signature) is refused", () => {
    const refusedWith = (r: ReturnType<typeof planAssets>, reason: string) =>
      expect(r).toMatchObject({ ok: false, reason });
    refusedWith(
      planAssets(gh2({}), ctx({ "release-binaries": ["x/a", "y/a"] }), true),
      "asset_name_collision",
    );
    refusedWith(
      planAssets(gh2({ assets: ["a"] }), ctx({ "release-binaries": ["sub/a"] }), true),
      "asset_name_collision",
    );
    refusedWith(
      planAssets(gh2({}), ctx({ "release-binaries": ["provenance.intoto.json"] }), true),
      "asset_name_collision",
    );
    refusedWith(
      planAssets(gh2({}), ctx({ "release-binaries": ["a.sig"] }, ["a.sig"]), true),
      "cosign_name_collision",
    );
  });

  test("a name that is not a plain name, or an artifact with no files, is refused", () => {
    for (const bad of ["a b", ".hidden", "x;y", "-x"]) {
      expect(planAssets(gh2({}), ctx({ "release-binaries": [`d/${bad}`] }), true)).toMatchObject({
        ok: false,
        reason: "bad_asset_name",
      });
    }
    expect(planAssets(gh2({}), ctx({}), true)).toMatchObject({
      ok: false,
      reason: "artifact_empty",
    });
  });
});

describe("npm: the artifact, not a file name", () => {
  test("an artifact with two .tgz files, or none, is refused after the GitHub release", async () => {
    blobs.set(
      "npm-package",
      buildZip([
        {
          name: "acmescan-1.0.0.tgz",
          data: await tarball({ name: "acmescan", version: "1.0.0" }),
        },
        { name: "other-1.0.0.tgz", data: await tarball({ name: "other", version: "1.0.0" }) },
      ]),
    );
    const two = await release();
    expect(two.result.published?.find((p) => p.target === "npm")).toMatchObject({
      state: "refused",
      reason: "ambiguous_tarball",
    });
    expect(npmPut).toEqual([]);
  });

  test("the old meaning (the tarball file's own name) still works", async () => {
    attest.setPublishTarget(
      a.orgId,
      a.projectId,
      "npm",
      { ...NPM_TARGET, artifact: "acmescan-1.0.0.tgz" } as PublishTarget,
      0,
    );
    const { result } = await release();
    expect(result.published?.find((p) => p.target === "npm")?.state).toBe("published");
  });
});

describe("the publish order is explicit", () => {
  test("github-release, then npm, then an image, whatever the keys are", () => {
    const targets: Record<string, PublishTarget> = {
      a: NPM_TARGET,
      b: { kind: "oci-image", mode: "compat" } as unknown as PublishTarget,
      z: GH_TARGET,
    };
    expect(publishOrder(targets)).toEqual(["z", "a", "b"]);
  });

  test("npm is published only after the release: the key order does not matter", async () => {
    attest.removePublishTarget(a.orgId, a.projectId, "github");
    attest.removePublishTarget(a.orgId, a.projectId, "npm");
    attest.setPublishTarget(a.orgId, a.projectId, "a-npm", NPM_TARGET, 0);
    attest.setPublishTarget(a.orgId, a.projectId, "z-github", GH_TARGET, 0);
    const { result } = await release();
    expect(result.published?.map((p) => p.target)).toEqual(["z-github", "a-npm"]);
    const order = reqs.map((r) => `${r.method} ${new URL(r.url).hostname}`);
    expect(order.indexOf("PUT registry.test")).toBeGreaterThan(
      order.lastIndexOf("PATCH api.gh.test"),
    );
  });

  test("a failed GitHub release skips npm: never attempted, recorded as skipped with the reason", async () => {
    gh.uploadStatus = 500;
    const { row, result } = await release();
    expect(row.status).toBe("signed"); // the signature stands
    expect(result.published?.map((p) => [p.target, p.state, p.reason])).toEqual([
      ["github", "failed", "http_500"],
      ["npm", "skipped", "github_release_not_published"],
    ]);
    expect(npmPut).toEqual([]);
    expect(reqs.some((r) => r.url.includes("registry.test"))).toBe(false);
    expect(gh.release?.draft).toBe(true);
    const audits = (await listAudit(db, a.scope)).map((x) => x.outcome);
    expect(audits).toContain("publish:npm:skipped:github_release_not_published");
  });

  test("with no GitHub release configured, npm goes on its own", async () => {
    attest.removePublishTarget(a.orgId, a.projectId, "github");
    const { result } = await release();
    expect(result.published?.map((p) => [p.target, p.state])).toEqual([["npm", "published"]]);
  });
});

describe("a dry run", () => {
  test("verifies everything and returns the publish plan; signs, publishes and reads no approval", async () => {
    const { row, result } = await release(goodSigs(), { dry: true });
    expect(row.status).toBe("signed"); // stored; the op reports it as `verified`
    expect(row.dryRun).toBe(true);
    nothingHappened();
    expect(
      attest.approvedRelease({ orgId: a.orgId, projectId: a.projectId, runId: a.runId }),
    ).toBeUndefined();
    const [plannedGh, plannedNpm] = result.plan!.targets;
    expect(plannedGh).toMatchObject({ key: "github", kind: "github-release", order: 1 });
    expect((plannedGh!.assets as string[]).toSorted()).toEqual(
      [
        "SHA256SUMS",
        "manifest.json",
        "manifest.json.sig",
        ...PLATFORMS.map((p) => binName(p)),
        ...PLATFORMS.map((p) => `${binName(p)}.sig`),
        "provenance.intoto.json",
      ].toSorted(),
    );
    expect(plannedNpm).toEqual({
      key: "npm",
      kind: "npm",
      order: 2,
      package: "acmescan",
      file: "acmescan-1.0.0.tgz",
      version: "1.0.0",
      dist_tag: "beta",
      after: ["github"],
    });
    expect((await listAudit(db, a.scope)).map((x) => x.outcome)).toContain("dry_run:ok");
    // and the same request can then be made for real: a dry run spent nothing
    const real = await release();
    expect(real.row.status).toBe("signed");
    expect(signs).toBe(1);
  });

  test("with no target configured the plan says so", async () => {
    attest.removePublishTarget(a.orgId, a.projectId, "github");
    attest.removePublishTarget(a.orgId, a.projectId, "npm");
    const { result } = await release(goodSigs(), { dry: true });
    expect(result.plan).toEqual({ targets: [], note: "none configured" });
  });

  test("a bad co-signature is refused, as for a real request", async () => {
    const sigs = goodSigs();
    sigs[2] = {
      ...sigs[2]!,
      signature_b64: b64(sigOf(newPair(), files.get(binName("darwin-arm64"))!)),
    };
    const { row } = await release(sigs, { dry: true });
    expect(row).toMatchObject({ status: "refused", reason: "signature_invalid" });
    nothingHappened();
  });

  test("a run that is not finished and successful, a missing signing key, or an unpublishable npm package are refused", async () => {
    await db.orm.update(s.runs).set({ status: "failure" }).where(eq(s.runs.id, a.runId));
    expect((await release(goodSigs(), { dry: true })).row).toMatchObject({
      status: "refused",
      reason: "run_not_successful",
    });
    await db.orm.update(s.runs).set({ status: "success" }).where(eq(s.runs.id, a.runId));
    checkKeyResult = { ok: false, reason: "the lane does not hold the project's signing key" };
    expect((await release(goodSigs(), { dry: true })).row).toMatchObject({
      status: "refused",
      reason: "no_signing_key",
    });
    checkKeyResult = { ok: true };
    blobs.set(
      "npm-package",
      buildZip([
        {
          name: "acmescan-9.9.9.tgz",
          data: await tarball({ name: "acmescan", version: "9.9.9" }),
        },
      ]),
    );
    expect((await release(goodSigs(), { dry: true })).row).toMatchObject({
      status: "refused",
      reason: "publish_plan_refused",
    });
    expect(signs).toBe(0);
    expect(reqs).toEqual([]);
  });

  test("a tag that is not the version in the manifest is refused", async () => {
    await db.orm.update(s.runs).set({ ref: "refs/tags/v1.0.1" }).where(eq(s.runs.id, a.runId));
    const { row } = await release(goodSigs(), { dry: true, tag: "v1.0.1" });
    expect(row).toMatchObject({ status: "refused", reason: "cosign_manifest_check" });
  });

  test("through the op: an operator may ask, a reader may not; the answer is `verified` with the plan; a real request still needs release_operator", async () => {
    const env = { registry, db };
    const operator = (await mintToken(db, a.scope, "operator")).secret;
    const reader = (await mintToken(db, a.scope, "reader")).secret;
    const relop = (await mintToken(db, a.scope, "release_operator")).secret;
    const input = {
      run_id: a.runId,
      tag: "v1.0.0",
      artifacts: ["release-binaries", "npm-package"],
      cosignatures: goodSigs(),
    };
    expect(
      (
        await dispatch(env, { kind: "bearer", token: reader }, "request_release", {
          ...input,
          dry_run: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await dispatch(env, { kind: "bearer", token: operator }, "request_release", input)).ok,
    ).toBe(false);
    const made = await dispatch(env, { kind: "bearer", token: operator }, "request_release", {
      ...input,
      dry_run: true,
    });
    expect(made.ok && (made.output as { dry_run: boolean; status: string })).toMatchObject({
      dry_run: true,
      status: "pending",
    });
    expect(await lane.processNext()).toBe(true);
    const id = (made.ok && (made.output as { id: string }).id)!;
    const got = await dispatch(env, { kind: "bearer", token: relop }, "get_release_request", {
      id,
    });
    const out =
      got.ok &&
      (got.output as {
        status: string;
        plan: { targets: unknown[] } | null;
        provenance: string | null;
      });
    expect(out).toMatchObject({ status: "verified", provenance: null });
    expect(out && out.plan?.targets).toHaveLength(2);
    expect(signs).toBe(0);
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("request_release");
  });
});

describe("a change of the co-signing key moves the lane's config version", () => {
  const scope = () => ({ orgId: a.orgId, projectId: a.projectId });

  test("changing the key after approval refuses the publish with `re-approval required`", async () => {
    attest.removePublishTarget(a.orgId, a.projectId, "github");
    attest.removePublishTarget(a.orgId, a.projectId, "npm");
    const first = await release();
    expect(first.row.status).toBe("signed");
    const approvedAt = attest.approvedRelease({ ...scope(), runId: a.runId })!.configVersion;
    expect(approvedAt).toBe(attest.configVersion());

    // targets declared later, then the key replaced: the approval is stale
    attest.setPublishTarget(a.orgId, a.projectId, "github", GH_TARGET, 0);
    const v = attest.configVersion();
    const rotated = newPair();
    setKey({ public_key_pem: rotated.pem });
    expect(attest.configVersion()).toBe(v + 1);
    const out = await lane.finalize({ ...scope(), runId: a.runId });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ target: "github", state: "refused" });
    expect(out[0]!.reason).toContain("re-approve");
    expect(reqs).toEqual([]);

    // removing the key moves it again
    const v2 = attest.configVersion();
    attest.removeCosignKey(a.orgId, a.projectId, "acme");
    expect(attest.configVersion()).toBe(v2 + 1);
    attest.removeCosignKey(a.orgId, a.projectId, "acme"); // already gone: no bump
    expect(attest.configVersion()).toBe(v2 + 1);
  });
});

describe("release_cosign_key_set / _remove / _list", () => {
  let h: Awaited<ReturnType<typeof opsHarness>>;
  beforeEach(async () => {
    h = await opsHarness({ db, attest, orgId: a.orgId });
  });
  afterEach(() => h.dispose());

  const input = (over: Record<string, unknown> = {}) => ({
    target_org: a.slug,
    target_project: a.projectSlug,
    name: "second",
    public_key_pem: newPair().pem,
    signs: "manifest.json",
    output_name: "second.json.sig",
    manifest_binaries: true,
    ...over,
  });

  test("set, list and remove round-trip through the lane's file, by fingerprint", async () => {
    const pem = newPair().pem;
    const v0 = attest.configVersion();
    const set = await h.signedCall(
      "release_cosign_key_set",
      input({
        public_key_pem: pem,
        name: "pinned",
        signs: "other.json",
        output_name: "other.json.sig",
      }),
    );
    expect(set.ok && set.output).toMatchObject({
      name: "pinned",
      key_id: cosignKeyId(pem),
      spki_sha256: cosignFingerprint(pem),
      manifest: true,
      config_version: v0 + 1,
    });
    expect(attest.cosignKeys(a.orgId, a.projectId).map((k) => k.name)).toEqual(["acme", "pinned"]);

    const list = await h.call("release_cosign_key_list", {
      target_org: a.slug,
      target_project: a.projectSlug,
    });
    expect(
      list.ok && (list.output as { keys: { name: string }[] }).keys.map((k) => k.name),
    ).toEqual(["acme", "pinned"]);
    expect(JSON.stringify(list)).not.toContain("PUBLIC KEY");

    const gone = await h.signedCall("release_cosign_key_remove", {
      target_org: a.slug,
      target_project: a.projectSlug,
      name: "pinned",
    });
    expect(gone.ok && gone.output).toMatchObject({ removed: true, config_version: v0 + 2 });
  });

  test("the audit records the fingerprint and the key id, never the key", async () => {
    const pem = newPair().pem;
    await h.signedCall(
      "release_cosign_key_set",
      input({ public_key_pem: pem, name: "pinned", signs: "x.json", output_name: "x.json.sig" }),
    );
    const row = (await listAudit(db, { orgId: a.orgId })).find(
      (r) => r.op === "release_cosign_key_set" && r.outcome === "ok",
    )!;
    const text = JSON.stringify(row.input);
    expect(text).toContain(cosignFingerprint(pem));
    expect(text).toContain(cosignKeyId(pem));
    expect(text).not.toContain("PUBLIC KEY");
    expect(text).not.toContain(pem.slice(30, 60));
  });

  test("a private key, a key that is not P-256 and a clashing set are refused", async () => {
    const priv = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const bad1 = await h.signedCall("release_cosign_key_set", input({ public_key_pem: priv }));
    expect(!bad1.ok && bad1.error.code).toBe("invalid_input");
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const bad2 = await h.signedCall("release_cosign_key_set", input({ public_key_pem: p384 }));
    expect(!bad2.ok && bad2.error.code).toBe("invalid_input");
    // `signs` already belongs to "acme"
    const bad3 = await h.signedCall("release_cosign_key_set", input({ output_name: "other.sig" }));
    expect(!bad3.ok && bad3.error.code).toBe("invalid_input");
    expect(attest.cosignKeys(a.orgId, a.projectId).map((k) => k.name)).toEqual(["acme"]);
  });

  test("a write needs the step-up; an org token, an instance token and MCP are refused", async () => {
    const noStepUp = await h.call("release_cosign_key_set", input());
    expect(!noStepUp.ok).toBe(true);
    const org = await dispatch(
      h.env,
      { kind: "principal", principal: a.admin },
      "release_cosign_key_set",
      input(),
    );
    expect(!org.ok && org.error.code).toBe("forbidden");
    const { createInstanceTokenFromCli } = await import("../src/ops/instance-token-cli");
    const tti = (await createInstanceTokenFromCli(db, { name: "probe" })).secret;
    for (const name of [
      "release_cosign_key_set",
      "release_cosign_key_remove",
      "release_cosign_key_list",
    ]) {
      expect(registry.get(name)!.mcp, name).toBe(false);
      expect(mcpTools(registry).map((t) => t.name)).not.toContain(name);
      const viaMcp = await dispatch(
        { registry, db, transport: "mcp", viaMcp: true },
        { kind: "bearer", token: tti },
        name,
        {},
      );
      expect(!viaMcp.ok && viaMcp.error.code, name).toBe("unauthenticated");
      const tt = await dispatch(h.env, { kind: "bearer", token: tti }, name, input());
      expect(tt.ok, name).toBe(false);
    }
    // nothing was written by any of them
    expect(attest.cosignKeys(a.orgId, a.projectId).map((k) => k.name)).toEqual(["acme"]);
  });

  test("a project that is not the org's cannot be named: the step-up is not even issued", async () => {
    await expect(
      h.signedCall("release_cosign_key_set", input({ target_project: "nope" })),
    ).rejects.toThrow(/not found/);
    expect(attest.cosignKeys(a.orgId, a.projectId).map((k) => k.name)).toEqual(["acme"]);
  });
});
