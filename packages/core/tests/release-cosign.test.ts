// #544: lane-verified co-signatures by a client-pinned key. Every key and signature here is made
// at runtime; nothing secret is in the repository.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import type { SafeFetch } from "@turntable/net";
import { clearFreeze, createReleaseRequest, getReleaseRequest, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { resetFailureThrottle } from "../src/audit/failures";
import { AttestationStore } from "../src/release/attest";
import { cosignKeyId, isMinimalEcdsaDer } from "../src/release/cosign";
import { ReleaseLane, type ReleaseSigner } from "../src/release/lane";
import type { PublishWiring } from "../src/release/publish/types";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const SHA = "a".repeat(40);
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
const GH_TOKEN = ["gh", "write", "token", "1b7c"].join("_");

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
const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

let db: Db;
let a: Tenant;
let attest: AttestationStore;
let blobs: Map<string, Uint8Array>;
let signed = 0;
let pair: Pair;
let lane: ReleaseLane;
let gh: {
  release?: {
    id: number;
    draft: boolean;
    assets: Map<number, { name: string; bytes: Uint8Array }>;
  };
  next: number;
};
let ghCalls = 0;

const signer: ReleaseSigner = {
  async signRelease(_scope, req) {
    signed += 1;
    return {
      ok: true,
      envelope: { payload: "eA==", signatures: [{ keyid: "k1", sig: "eQ==" }] },
      keyid: "k1",
      subjects: req.verified.subjects.map((x) => ({ ...x })),
    };
  },
};

const fakeFetch: SafeFetch = async (input, init) => {
  ghCalls += 1;
  const u = new URL(String(input));
  const method = init?.method ?? "GET";
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : "";
  const m =
    /^\/repos\/[^/]+\/[^/]+\/releases(?:\/tags\/([^/]+)|\/assets\/(\d+)|\/(\d+)\/assets|\/(\d+))?$/.exec(
      u.pathname,
    );
  const json = (st: number, b: unknown = {}) =>
    st === 204 ? new Response(null, { status: st }) : Response.json(b, { status: st });
  if (!m) return json(404);
  const [, tagName, assetId, uploadFor, relId] = m;
  if (method === "GET" && tagName) {
    if (!gh.release) return json(404);
    return json(200, {
      id: gh.release.id,
      draft: gh.release.draft,
      assets: [...gh.release.assets].map(([id, x]) => ({ id, name: x.name })),
    });
  }
  if (method === "POST" && !tagName && !assetId && !uploadFor && !relId) {
    gh.release = { id: ++gh.next, draft: true, assets: new Map() };
    return json(201, { id: gh.release.id, draft: true, assets: [] });
  }
  if (method === "POST" && uploadFor) {
    gh.release!.assets.set(++gh.next, {
      name: u.searchParams.get("name")!,
      bytes: raw as Uint8Array,
    });
    return json(201);
  }
  if (method === "GET" && assetId) {
    const x = gh.release?.assets.get(Number(assetId));
    return x ? new Response(x.bytes, { status: 200 }) : json(404);
  }
  if (method === "PATCH" && relId) {
    gh.release!.draft = (JSON.parse(text) as { draft: boolean }).draft;
    return json(200);
  }
  return json(404);
};

const wiring: PublishWiring = {
  credentials: { secret: async () => undefined, githubToken: async () => GH_TOKEN },
  fetch: fakeFetch,
  githubApi: "https://api.gh.test",
  githubUploads: "https://up.gh.test",
};

/** A manifest document (the per-binary manifest check has its own tests, release-cosign-manifest). */
const manifestFor = (p: Pair, bin: Uint8Array): Uint8Array =>
  enc(JSON.stringify({ signing_key_id: cosignKeyId(p.pem), sha256: sha256(bin) }));

const BIN = enc("linux binary");

function configure(p: Pair, manifest = false): void {
  attest.setCosignKey(
    a.orgId,
    a.projectId,
    {
      name: "pinned",
      public_key_pem: p.pem,
      signs: "manifest.json",
      output_name: "manifest.json.sig",
      format: "detached-der-p256-sha256",
      ...(manifest ? { manifest: { shape: "binaries-map" } } : {}),
    },
    0,
  );
}

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  resetFailureThrottle();
  pair = newPair();
  blobs = new Map([
    ["cli-linux", BIN],
    ["manifest.json", manifestFor(pair, BIN)],
  ]);
  signed = 0;
  ghCalls = 0;
  gh = { next: 100 };
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
  attest.setPublishTarget(
    a.orgId,
    a.projectId,
    "gh",
    {
      kind: "github-release",
      mode: "strict",
      assets: ["cli-linux", "manifest.json"],
      provenanceAsset: "provenance.intoto.json",
    },
    0,
  );
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
    .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
});
afterEach(async () => {
  await clearFreeze(db, a.scope).catch(() => {});
  attest.close();
});

async function release(cosignatures?: { name: string; signature_b64: string }[]) {
  const r = await createReleaseRequest(db, a.scope, {
    runId: a.runId,
    tag: "v1.0.0",
    artifacts: ["cli-linux", "manifest.json"],
    ...(cosignatures ? { cosignatures } : {}),
    requestedBy: "test",
  });
  expect(await lane.processNext()).toBe(true);
  return (await getReleaseRequest(db, a.scope, r.id))!;
}
const goodSig = (p = pair, bytes = blobs.get("manifest.json")!) => [
  { name: "pinned", signature_b64: b64(sigOf(p, bytes)) },
];
const heldAssets = () => [...(gh.release?.assets.values() ?? [])].map((x) => x.name).toSorted();
const nothingPublished = () => {
  expect(signed).toBe(0);
  expect(ghCalls).toBe(0);
};

describe("a valid co-signature", () => {
  test("publishes both signatures: the lane's provenance and the co-signature under its exact name", async () => {
    configure(pair);
    const sig = sigOf(pair, blobs.get("manifest.json")!);
    const row = await release([{ name: "pinned", signature_b64: b64(sig) }]);
    expect(row.status).toBe("signed");
    expect(signed).toBe(1);
    expect(gh.release?.draft).toBe(false);
    expect(heldAssets()).toEqual([
      "cli-linux",
      "manifest.json",
      "manifest.json.sig",
      "provenance.intoto.json",
    ]);
    const held = [...gh.release!.assets.values()].find((x) => x.name === "manifest.json.sig")!;
    expect(Buffer.from(held.bytes).equals(Buffer.from(sig))).toBe(true); // raw DER, not base64
    expect(JSON.parse(row.result!).cosignatures).toEqual([
      {
        name: "pinned",
        key_id: cosignKeyId(pair.pem),
        signs: "manifest.json",
        output_name: "manifest.json.sig",
        signature_sha256: sha256(sig),
      },
    ]);
  });

  test("get_release_request shows present, then verified, with a fingerprint and no key material", async () => {
    configure(pair);
    const env = { registry, db };
    const tok = (await mintToken(db, a.scope, "release_operator")).secret;
    const made = await dispatch(env, { kind: "bearer", token: tok }, "request_release", {
      run_id: a.runId,
      tag: "v1.0.0",
      artifacts: ["cli-linux", "manifest.json"],
      cosignatures: goodSig(),
    });
    expect(made.ok).toBe(true);
    const id = (made.ok && (made.output as { id: string }).id)!;
    const get = async () => {
      const r = await dispatch(env, { kind: "bearer", token: tok }, "get_release_request", { id });
      return (r.ok ? r.output : r) as {
        cosignatures: { name: string; status: string; key_id?: string }[];
      };
    };
    expect((await get()).cosignatures).toEqual([{ name: "pinned", status: "present" }]);
    expect(await lane.processNext()).toBe(true);
    const done = await get();
    expect(done.cosignatures).toEqual([
      { name: "pinned", status: "verified", key_id: cosignKeyId(pair.pem) },
    ]);
    expect(JSON.stringify(done)).not.toContain("BEGIN PUBLIC KEY");
  });

  test("a project with no co-signing key is unchanged: no extra asset, nothing carried", async () => {
    const row = await release();
    expect(row.status).toBe("signed");
    expect(heldAssets()).toEqual(["cli-linux", "manifest.json", "provenance.intoto.json"]);
    expect(JSON.parse(row.result!).cosignatures).toBeUndefined();
  });

  test("a co-signature for a key that is not configured is refused", async () => {
    const row = await release(goodSig());
    expect(row).toMatchObject({ status: "refused", reason: "cosign_unexpected" });
    nothingPublished();
  });
});

describe("a co-signature that is missing or bad publishes nothing", () => {
  test("missing: refused with a clear reason, and the status says so", async () => {
    configure(pair);
    const row = await release();
    expect(row).toMatchObject({ status: "refused", reason: "cosign_missing" });
    expect(row.detail).toContain("pinned must co-sign manifest.json");
    expect(JSON.parse(row.facts!).cosignatures).toEqual([
      {
        name: "pinned",
        status: "missing",
        key_id: cosignKeyId(pair.pem),
        reason: "cosign_missing",
      },
    ]);
    nothingPublished();
  });

  test("wrong key", async () => {
    configure(pair);
    const row = await release(goodSig(newPair()));
    expect(row).toMatchObject({ status: "refused", reason: "signature_invalid" });
    nothingPublished();
  });

  test("wrong statement: a signature over other bytes", async () => {
    configure(pair);
    const row = await release(goodSig(pair, enc("something else")));
    expect(row).toMatchObject({ status: "refused", reason: "signature_invalid" });
    nothingPublished();
  });

  test("a co-signature over a different release is refused", async () => {
    configure(pair);
    // a valid signature over the PREVIOUS release's manifest
    const previous = manifestFor(pair, enc("older binary"));
    const row = await release(goodSig(pair, previous));
    expect(row).toMatchObject({ status: "refused", reason: "signature_invalid" });
    nothingPublished();
  });

  test("a non-minimal DER encoding of a valid signature is rejected", async () => {
    configure(pair);
    const der = sigOf(pair, blobs.get("manifest.json")!);
    expect(isMinimalEcdsaDer(der)).toBe(true);
    // the same SEQUENCE with a needless long-form length: BER-ish, valid to a lax parser
    const padded = new Uint8Array([0x30, 0x81, der.length - 2, ...der.subarray(2)]);
    expect(isMinimalEcdsaDer(padded)).toBe(false);
    // and an INTEGER with a needless leading zero
    const r = der.subarray(4, 4 + der[3]!);
    const rest = der.subarray(4 + der[3]!);
    const lead = new Uint8Array([
      0x30,
      der[1]! + 1,
      0x02,
      r.length + 1,
      ...(r[0]! & 0x80 ? [] : [0]),
      ...r,
      ...rest,
    ]);
    if (!(r[0]! & 0x80)) expect(isMinimalEcdsaDer(lead)).toBe(false);
    const row = await release([{ name: "pinned", signature_b64: b64(padded) }]);
    expect(row).toMatchObject({ status: "refused", reason: "signature_not_minimal_der" });
    nothingPublished();
  });

  test("not base64, repeated, or naming an unknown key", async () => {
    configure(pair);
    expect(await release([{ name: "pinned", signature_b64: "not base64!" }])).toMatchObject({
      reason: "cosign_bad_encoding",
    });
    expect(await release([...goodSig(), ...goodSig()])).toMatchObject({
      reason: "cosign_duplicate",
    });
    expect(await release([...goodSig(), { name: "extra", signature_b64: "AAAA" }])).toMatchObject({
      reason: "cosign_unexpected",
    });
    nothingPublished();
  });

  test("a signed file that is not in the release", async () => {
    attest.setCosignKey(
      a.orgId,
      a.projectId,
      {
        name: "pinned",
        public_key_pem: pair.pem,
        signs: "absent.json",
        output_name: "absent.json.sig",
        format: "detached-der-p256-sha256",
      },
      0,
    );
    const row = await release(goodSig());
    expect(row).toMatchObject({ status: "refused", reason: "cosign_artifact_missing" });
    nothingPublished();
  });
});

describe("configuration is public material only, in the lane's own file", () => {
  test("a private key, a non-P-256 key, an unknown format and a clashing set are refused", () => {
    expect(() =>
      attest.setCosignKey(
        a.orgId,
        a.projectId,
        {
          name: "k",
          public_key_pem: pair.priv.export({ type: "pkcs8", format: "pem" }).toString(),
          signs: "m",
          output_name: "m.sig",
          format: "detached-der-p256-sha256",
        },
        0,
      ),
    ).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(() =>
      attest.setCosignKey(
        a.orgId,
        a.projectId,
        {
          name: "k",
          public_key_pem: rsa.toString(),
          signs: "m",
          output_name: "m.sig",
          format: "detached-der-p256-sha256",
        },
        0,
      ),
    ).toThrow(/P-256/);
    expect(() =>
      attest.setCosignKey(
        a.orgId,
        a.projectId,
        {
          name: "k",
          public_key_pem: pair.pem,
          signs: "m",
          output_name: "m.sig",
          format: "nope",
        },
        0,
      ),
    ).toThrow(/format/);
    configure(pair);
    expect(() =>
      attest.setCosignKey(
        a.orgId,
        a.projectId,
        {
          name: "second",
          public_key_pem: pair.pem,
          signs: "manifest.json",
          output_name: "other.sig",
          format: "detached-der-p256-sha256",
        },
        0,
      ),
    ).toThrow(/unique/);
  });

  test("an unreadable configuration row refuses the release instead of waiving the requirement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosign-attest-"));
    const file = join(dir, "attested.db");
    attest.close();
    attest = new AttestationStore(file);
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    configure(pair);
    const raw = new Database(file);
    raw.run("UPDATE cosign_keys SET config = '{not json'");
    raw.close();
    lane = new ReleaseLane({
      db,
      forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
      bytes: { read: async (_run, name) => blobs.get(name) },
      records: {
        async recorded(_scope, _run, names) {
          return names.map((n) => ({ name: n, sha256: sha256(blobs.get(n)!) }));
        },
      },
      attest,
      signer,
      owner: "lane-1",
    });
    const row = await release(goodSig());
    expect(row).toMatchObject({ status: "refused", reason: "cosign_config_error" });
    expect(signed).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the main process neither verifies nor reads the co-signing configuration", () => {
  test("source guard: only the release directory touches the co-signing keys and verifier", () => {
    const SRC = join(import.meta.dir, "../src");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
      );
    const violations: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel.startsWith("release/")) continue;
      if (rel.startsWith("db/migrations") || rel.startsWith("db/migrations.")) continue;
      const text = readFileSync(f, "utf8");
      if (/verifyCosignatures|cosignKeys\(|setCosignKey|cosign_keys|release\/cosign/.test(text))
        violations.push(rel);
    }
    expect(violations).toEqual([]);
  });

  test("request_release only carries the signature: a bad one is accepted as pending, never checked", async () => {
    const env = { registry, db };
    const tok = (await mintToken(db, a.scope, "release_operator")).secret;
    const r = await dispatch(env, { kind: "bearer", token: tok }, "request_release", {
      run_id: a.runId,
      tag: "v1.0.0",
      artifacts: ["cli-linux"],
      cosignatures: [{ name: "pinned", signature_b64: "AAAA" }],
    });
    expect(r.ok && (r.output as { status: string }).status).toBe("pending");
    expect(r.ok && (r.output as { cosignatures: unknown[] }).cosignatures).toEqual([
      { name: "pinned", status: "present" },
    ]);
  });

  test("the lane's file is not the main database: the main schema has no co-signing key table", () => {
    const names = Object.keys(s).filter((k) => /cosign/i.test(k));
    expect(names).toEqual([]);
  });
});
