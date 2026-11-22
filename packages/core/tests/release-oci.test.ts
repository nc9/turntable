import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SafeFetch } from "@longshore/net";
import { chainedAudit, createReleaseRequest, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { AttestationStore } from "../src/release/attest";
import { ReleaseLane } from "../src/release/lane";
import { PROVENANCE_ARTIFACT_TYPE, PROVENANCE_LAYER_TYPE } from "../src/release/publish/oci";
import type { PublishTarget } from "../src/release/publish/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const SHA = "e".repeat(40);
const CRED = ["reg", "cred", "value", "4471"].join("_");
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (x: string): Uint8Array => new TextEncoder().encode(x);

const MANIFEST = enc(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    layers: [],
  }),
);
const OTHER = enc(JSON.stringify({ schemaVersion: 2, layers: [{ digest: "sha256:evil" }] }));
const OCI: PublishTarget = {
  kind: "oci-image",
  mode: "compat",
  registry: "registry.test",
  repository: "acme/web",
  manifest: "manifest.json",
  tags: ["v1.0.0", "latest"],
  username: "bot",
  secret: "REGISTRY_TOKEN",
};
const GH: PublishTarget = {
  kind: "github-release",
  mode: "strict",
  assets: ["manifest.json"],
  provenanceAsset: "provenance.intoto.json",
};
const BEARER = "bearer_for_the_lane_12345";

interface Fake {
  /** reference (tag or sha256:...) -> bytes */
  manifests: Map<string, Uint8Array>;
  blobs: Map<string, Uint8Array>;
  referrers: boolean;
  requests: { method: string; url: string; auth: string }[];
  realm: string;
  puts: string[];
}
let fake: Fake;

const fetcher: SafeFetch = async (input, init) => {
  const u = new URL(String(input));
  const method = init?.method ?? "GET";
  const h = new Headers(init?.headers);
  fake.requests.push({ method, url: String(input), auth: h.get("authorization") ?? "" });
  if (u.hostname !== "registry.test") return new Response("", { status: 404 });
  if (u.pathname === "/token") {
    const want = `Basic ${Buffer.from(`bot:${CRED}`).toString("base64")}`;
    return h.get("authorization") === want
      ? Response.json({ token: BEARER })
      : new Response("", { status: 401 });
  }
  const authed = h.get("authorization") === `Bearer ${BEARER}`;
  if (u.pathname === "/v2/") {
    return authed
      ? new Response("{}", { status: 200 })
      : new Response("", {
          status: 401,
          headers: { "www-authenticate": `Bearer realm="${fake.realm}",service="reg"` },
        });
  }
  if (!authed) return new Response("", { status: 401 });
  const m = /^\/v2\/acme\/web\/(manifests|blobs|referrers)\/(.+)$/.exec(u.pathname);
  if (u.pathname === "/v2/acme/web/blobs/uploads/" && method === "POST")
    return new Response("", {
      status: 202,
      headers: { location: "/v2/acme/web/blobs/uploads/u1" },
    });
  if (u.pathname === "/v2/acme/web/blobs/uploads/u1" && method === "PUT") {
    fake.blobs.set(u.searchParams.get("digest")!, init!.body as Uint8Array);
    return new Response("", { status: 201 });
  }
  if (!m) return new Response("", { status: 404 });
  const [, kind, ref] = m;
  if (kind === "blobs") return new Response("", { status: fake.blobs.has(ref!) ? 200 : 404 });
  if (kind === "manifests" && method === "GET") {
    const b = fake.manifests.get(decodeURIComponent(ref!));
    return b
      ? new Response(b, {
          status: 200,
          headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
        })
      : new Response("", { status: 404 });
  }
  if (kind === "manifests" && method === "PUT") {
    const bytes = init!.body as Uint8Array;
    fake.manifests.set(ref!, bytes);
    fake.puts.push(ref!);
    const subject = (
      JSON.parse(new TextDecoder().decode(bytes)) as { subject?: { digest: string } }
    ).subject?.digest;
    return new Response("", {
      status: 201,
      headers: fake.referrers && subject ? { "oci-subject": subject } : {},
    });
  }
  if (kind === "referrers") {
    if (!fake.referrers) return new Response("", { status: 404 });
    const want = decodeURIComponent(ref!);
    const manifests = [...fake.manifests]
      .filter(([, b]) => {
        try {
          return (
            (JSON.parse(new TextDecoder().decode(b)) as { subject?: { digest: string } }).subject
              ?.digest === want
          );
        } catch {
          return false;
        }
      })
      .map(([r]) => ({ digest: r, mediaType: "application/vnd.oci.image.manifest.v1+json" }));
    return Response.json({ schemaVersion: 2, manifests });
  }
  return new Response("", { status: 404 });
};

let db: Db;
let a: Tenant;
let attest: AttestationStore;
let lane: ReleaseLane;
let secretAvailable = true;
const ENVELOPE = {
  payloadType: "application/vnd.in-toto+json",
  payload: "eA==",
  signatures: [{ keyid: "k", sig: "eQ==" }],
};

const audits = async () =>
  (await chainedAudit(db, a.orgId, 0, 500)).filter((r) => r.op === "release_lane");
const finalize = () => lane.finalize({ ...a.scope, runId: a.runId });

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  secretAvailable = true;
  fake = {
    manifests: new Map([
      ["v1.0.0", MANIFEST],
      ["latest", MANIFEST],
      [`sha256:${sha256(MANIFEST)}`, MANIFEST],
    ]),
    blobs: new Map(),
    referrers: true,
    requests: [],
    realm: "https://registry.test/token",
    puts: [],
  };
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
  attest.setPublishTarget(a.orgId, a.projectId, "img", OCI, 0);
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
  await createReleaseRequest(db, a.scope, {
    runId: a.runId,
    tag: "v1.0.0",
    artifacts: ["manifest.json"],
    requestedBy: "t",
  });
  lane = new ReleaseLane({
    db,
    forge: { tagCommit: async () => ({ found: true, sha: SHA }) },
    bytes: { read: async (_r, n) => (n === "manifest.json" ? MANIFEST : undefined) },
    records: {
      async recorded(_s, _r, names) {
        return names.map((n) => ({ name: n, sha256: sha256(MANIFEST) }));
      },
    },
    attest,
    signer: {
      async signRelease(_s, req) {
        return {
          ok: true,
          envelope: ENVELOPE,
          keyid: "k",
          subjects: req.verified.subjects.map((x) => ({ ...x })),
        };
      },
    },
    publish: {
      credentials: {
        secret: async () => (secretAvailable ? CRED : undefined),
        githubToken: async () => undefined,
      },
      fetch: fetcher,
    },
    owner: "lane-1",
    now: () => 1_800_000_000_000,
  });
  await lane.processNext();
});
afterEach(() => attest.close());

describe("an image pushed by a job", () => {
  test("signing alone publishes nothing: the image waits for the job", () => {
    expect(fake.requests).toEqual([]);
    expect(attest.publishState({ ...a.scope, repo: "acme/web", tag: "v1.0.0" }, "img")?.state).toBe(
      "pending",
    );
  });

  test("the registry holds the attested image under every reference, and our provenance goes on it as a referrer", async () => {
    const [r] = await finalize();
    expect(r).toMatchObject({ target: "img", state: "published" });
    expect(r!.facts).toMatchObject({
      provenance: "referrer",
      digest: `sha256:${sha256(MANIFEST)}`,
    });
    // the referrer manifest, as the registry now holds it
    const ref = fake.puts[0]!;
    const doc = JSON.parse(new TextDecoder().decode(fake.manifests.get(ref)!)) as Record<
      string,
      any
    >;
    expect(ref).toBe(`sha256:${sha256(fake.manifests.get(ref)!)}`);
    expect(doc.artifactType).toBe(PROVENANCE_ARTIFACT_TYPE);
    expect(doc.subject).toMatchObject({
      digest: `sha256:${sha256(MANIFEST)}`,
      size: MANIFEST.length,
    });
    expect(doc.layers[0].mediaType).toBe(PROVENANCE_LAYER_TYPE);
    // the layer is the lane's own envelope
    const layer = fake.blobs.get(doc.layers[0].digest)!;
    expect(JSON.parse(new TextDecoder().decode(layer))).toEqual(ENVELOPE);
    expect(fake.blobs.has(doc.config.digest)).toBe(true);
    // the credential went to the registry's token endpoint only, as Basic; then a bearer
    const withCred = fake.requests.filter((q) => q.auth.startsWith("Basic"));
    expect(withCred.map((q) => new URL(q.url).pathname)).toEqual(["/token"]);
    expect(fake.requests.some((q) => q.auth === `Bearer ${BEARER}`)).toBe(true);
    // never in the audit trail
    const log = JSON.stringify(await audits());
    expect(log).not.toContain(CRED);
    expect(log).not.toContain(BEARER);
    expect((await audits()).map((x) => x.outcome)).toContain("publish:img:published");
  });

  test("asking again does not push the referrer twice", async () => {
    await finalize();
    attest.setPublishState(
      { ...a.scope, repo: "acme/web", tag: "v1.0.0" },
      "img",
      "pending",
      null,
      0,
    );
    const before = fake.puts.length;
    const [r] = await finalize();
    expect(r).toMatchObject({ state: "already" });
    expect(fake.puts.length).toBe(before);
  });

  test("a tag that points at other bytes is refused, nothing is attached, and both digests are audited", async () => {
    fake.manifests.set("latest", OTHER);
    const [r] = await finalize();
    expect(r).toMatchObject({ state: "refused", reason: "image_digest_mismatch" });
    expect(r!.detail).toContain(`sha256:${sha256(OTHER)}`);
    expect(r!.detail).toContain(`sha256:${sha256(MANIFEST)}`);
    expect(fake.puts).toEqual([]);
    const row = (await audits()).find(
      (x) => x.outcome === "publish:img:refused:image_digest_mismatch",
    );
    expect(row?.input).toContain(sha256(OTHER));
  });

  test("an image the job never pushed is a failed target, not a success", async () => {
    fake.manifests.delete("v1.0.0");
    expect((await finalize())[0]).toMatchObject({ state: "failed", reason: "manifest_missing" });
    fake.manifests.set("v1.0.0", MANIFEST);
    fake.manifests.delete(`sha256:${sha256(MANIFEST)}`);
    expect((await finalize())[0]).toMatchObject({ state: "failed", reason: "manifest_missing" });
    expect(fake.puts).toEqual([]);
  });

  test("a registry with no referrers API leaves the provenance as a release asset", async () => {
    fake.referrers = false;
    attest.setPublishTarget(a.orgId, a.projectId, "rel", GH, 0);
    const out = await finalize();
    const img = out.find((x) => x.target === "img")!;
    expect(img).toMatchObject({ state: "published", reason: "provenance_as_release_asset" });
    expect(img.facts).toMatchObject({ provenance: "release-asset" });
  });

  test("without a GitHub release target to carry it, the missing provenance is stated, not hidden", async () => {
    fake.referrers = false;
    const [r] = await finalize();
    expect(r).toMatchObject({ state: "published", reason: "provenance_unattached" });
    expect(r!.facts).toMatchObject({ provenance: "none" });
  });

  test("a token realm on another host never sees the credential", async () => {
    fake.realm = "https://evil.test/token";
    const [r] = await finalize();
    expect(r).toMatchObject({ state: "failed", reason: "auth_failed" });
    expect(fake.requests.every((q) => !q.auth)).toBe(true);
  });

  test("a credential the vault will not give fails the target before the registry is asked", async () => {
    secretAvailable = false;
    expect((await finalize())[0]).toMatchObject({
      state: "failed",
      reason: "credential_unavailable",
    });
    expect(fake.requests).toEqual([]);
  });
});
