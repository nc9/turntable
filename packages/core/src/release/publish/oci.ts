// A container image published by a job through the release proxy: after the job, the lane looks at
// what the registry holds. It fetches the manifest by every pushed reference and checks that its
// bytes hash to the digest the lane attested, then attaches the lane's own signed provenance as an
// OCI 1.1 referrer of that image (subject = the image manifest). A registry without the referrers
// API cannot carry it: the provenance then stays a release asset (see the GitHub release target).
import { createHash } from "node:crypto";
import { safeFetch, type SafeFetch } from "@longshore/net";
import type { OciTarget, PublishContext, TargetResult } from "./types";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const EMPTY_CONFIG = new TextEncoder().encode("{}");
const EMPTY_TYPE = "application/vnd.oci.empty.v1+json";
export const PROVENANCE_ARTIFACT_TYPE = "application/vnd.in-toto+json";
export const PROVENANCE_LAYER_TYPE = "application/vnd.dsse.envelope.v1+json";
const MAX_MANIFEST = 4 * 1024 * 1024;

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export interface OciOptions {
  fetch?: SafeFetch;
  /** True when the project has a GitHub release target that carries the provenance as an asset. */
  releaseAssetFallback?: boolean;
}

interface Auth {
  header: string | undefined;
}

export async function verifyOciImage(
  key: string,
  t: OciTarget,
  ctx: PublishContext,
  credential: string,
  o: OciOptions = {},
): Promise<TargetResult> {
  const f = o.fetch ?? safeFetch;
  const base = `https://${t.registry}`;
  const repo = t.repository;
  const refuse = (
    reason: string,
    detail?: string,
    facts?: Record<string, unknown>,
  ): TargetResult => ({
    target: key,
    state: "refused",
    reason,
    ...(detail ? { detail } : {}),
    ...(facts ? { facts } : {}),
  });
  const failed = (reason: string, detail?: string): TargetResult => ({
    target: key,
    state: "failed",
    reason,
    ...(detail ? { detail } : {}),
  });

  // The digest the lane attested for the manifest, re-derived from the bytes it holds.
  const manifestBytes = await ctx.readBytes(t.manifest);
  if (!manifestBytes) return refuse("artifact_bytes_missing", t.manifest);
  const want = sha256(manifestBytes);
  if (ctx.digests[t.manifest] !== want) return refuse("digest_mismatch", t.manifest);

  // ---- authentication: the registry's own challenge, answered with the lane's credential ----
  const call = (url: string, init: Parameters<SafeFetch>[1]): Promise<Response> =>
    f(url, { timeoutMs: 30_000, maxBytes: MAX_MANIFEST, ...init });
  let auth: Auth;
  try {
    auth = await authenticate();
  } catch (e) {
    return failed("auth_failed", e instanceof Error ? e.message : String(e));
  }
  async function authenticate(): Promise<Auth> {
    const ping = await call(`${base}/v2/`, { method: "GET", redirect: "manual" });
    void ping.body?.cancel();
    if (ping.status === 200) return { header: undefined };
    const challenge = ping.headers.get("www-authenticate") ?? "";
    if (ping.status !== 401) throw new Error(`registry ping: HTTP ${ping.status}`);
    const basic = `Basic ${Buffer.from(`${t.username}:${credential}`).toString("base64")}`;
    if (/^basic\b/i.test(challenge)) return { header: basic };
    const realm = /realm="([^"]+)"/i.exec(challenge)?.[1];
    const service = /service="([^"]*)"/i.exec(challenge)?.[1];
    if (!/^bearer\b/i.test(challenge) || !realm) throw new Error("no usable challenge");
    const url = new URL(realm);
    if (url.protocol !== "https:" || url.hostname !== t.registry || url.username || url.password)
      throw new Error("the token realm is not on the registry's host");
    url.search = "";
    url.searchParams.set("scope", `repository:${repo}:pull,push`);
    if (service) url.searchParams.set("service", service);
    const res = await call(url.toString(), {
      method: "GET",
      headers: { authorization: basic, accept: "application/json" },
      redirect: "manual",
    });
    if (res.status !== 200) throw new Error(`token exchange: HTTP ${res.status}`);
    const doc = (await res.json()) as { token?: unknown; access_token?: unknown };
    const token = typeof doc.token === "string" ? doc.token : doc.access_token;
    if (typeof token !== "string" || token === "") throw new Error("no token in the reply");
    return { header: `Bearer ${token}` };
  }
  const h = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(auth.header ? { authorization: auth.header } : {}),
    "user-agent": "longshore",
    ...extra,
  });

  // ---- the pushed manifest, by every reference, must be the attested bytes ----
  let subject: { mediaType: string; size: number } | undefined;
  for (const ref of [...t.tags, `sha256:${want}`]) {
    const res = await call(`${base}/v2/${repo}/manifests/${encodeURIComponent(ref)}`, {
      method: "GET",
      headers: h({ accept: MANIFEST_TYPES.join(", ") }),
      redirect: "manual",
    });
    if (res.status === 404) return failed("manifest_missing", `${ref} is not on the registry`);
    if (res.status !== 200) return failed(`http_${res.status}`, `reading the manifest ${ref}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const seen = sha256(bytes);
    if (seen !== want) {
      return refuse(
        "image_digest_mismatch",
        `${t.repository}:${ref} holds sha256:${seen}, the attested image is sha256:${want}`,
        { reference: ref, seen: `sha256:${seen}`, expected: `sha256:${want}` },
      );
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    subject = {
      mediaType: MANIFEST_TYPES.includes(type)
        ? type
        : "application/vnd.oci.image.manifest.v1+json",
      size: bytes.length,
    };
  }
  const facts = { registry: t.registry, repository: repo, digest: `sha256:${want}`, tags: t.tags };

  // ---- our provenance, as a referrer of the image ----
  if (ctx.provenance === undefined) return { target: key, state: "published", facts };
  const layer = new TextEncoder().encode(ctx.provenance);
  const layerDigest = `sha256:${sha256(layer)}`;
  const configDigest = `sha256:${sha256(EMPTY_CONFIG)}`;
  const referrer = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: PROVENANCE_ARTIFACT_TYPE,
      config: { mediaType: EMPTY_TYPE, digest: configDigest, size: EMPTY_CONFIG.length },
      layers: [{ mediaType: PROVENANCE_LAYER_TYPE, digest: layerDigest, size: layer.length }],
      subject: { mediaType: subject!.mediaType, digest: `sha256:${want}`, size: subject!.size },
    }),
  );
  const referrerDigest = `sha256:${sha256(referrer)}`;

  const listed = async (): Promise<boolean | "unsupported"> => {
    const res = await call(`${base}/v2/${repo}/referrers/sha256:${want}`, {
      method: "GET",
      headers: h({ accept: "application/vnd.oci.image.index.v1+json" }),
      redirect: "manual",
    });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      void res.body?.cancel();
      return "unsupported";
    }
    if (res.status !== 200) {
      void res.body?.cancel();
      throw new Error(`referrers: HTTP ${res.status}`);
    }
    const doc = (await res.json()) as { manifests?: { digest?: string }[] };
    return (doc.manifests ?? []).some((m) => m.digest === referrerDigest);
  };
  const fallback = (why: string): TargetResult => ({
    target: key,
    state: "published",
    reason: o.releaseAssetFallback ? "provenance_as_release_asset" : "provenance_unattached",
    detail: o.releaseAssetFallback
      ? `${why}: the provenance is attached to the GitHub release instead`
      : `${why}, and no GitHub release target carries the provenance`,
    facts: { ...facts, provenance: o.releaseAssetFallback ? "release-asset" : "none" },
  });
  const push = async (digest: string, bytes: Uint8Array): Promise<void> => {
    const head = await call(`${base}/v2/${repo}/blobs/${digest}`, {
      method: "HEAD",
      headers: h(),
      redirect: "manual",
    });
    void head.body?.cancel();
    if (head.status === 200) return;
    const open = await call(`${base}/v2/${repo}/blobs/uploads/`, {
      method: "POST",
      headers: h(),
      redirect: "manual",
    });
    void open.body?.cancel();
    const loc = open.headers.get("location");
    if (open.status !== 202 || !loc) throw new Error(`starting a blob upload: HTTP ${open.status}`);
    const target = new URL(loc, base);
    if (target.hostname !== t.registry || target.protocol !== "https:")
      throw new Error("the registry sent the upload to another host");
    target.searchParams.set("digest", digest);
    const done = await call(target.toString(), {
      method: "PUT",
      headers: h({ "content-type": "application/octet-stream" }),
      body: bytes,
      redirect: "manual",
    });
    void done.body?.cancel();
    if (done.status !== 201) throw new Error(`uploading a blob: HTTP ${done.status}`);
  };

  try {
    const before = await listed();
    if (before === true) return { target: key, state: "already", facts };
    await push(configDigest, EMPTY_CONFIG);
    await push(layerDigest, layer);
    const put = await call(`${base}/v2/${repo}/manifests/${referrerDigest}`, {
      method: "PUT",
      headers: h({ "content-type": "application/vnd.oci.image.manifest.v1+json" }),
      body: referrer,
      redirect: "manual",
    });
    void put.body?.cancel();
    if (put.status !== 201) return failed(`http_${put.status}`, "pushing the provenance referrer");
    // The registry says it indexed the referrer by echoing the subject; else ask the API.
    const indexed =
      put.headers.get("oci-subject") === `sha256:${want}` || (await listed()) === true;
    if (!indexed) return fallback("the registry has no referrers API");
    return {
      target: key,
      state: "published",
      facts: { ...facts, provenance: "referrer", referrer: referrerDigest },
    };
  } catch (e) {
    return failed("provenance_failed", e instanceof Error ? e.message : String(e));
  }
}
