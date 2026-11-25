// GitHub Releases: the lane creates the release as a DRAFT, attaches exactly the bytes it
// verified (and the signed provenance), checks what GitHub now holds, and only then publishes it.
// A release that is already published is never touched: it is left alone if it matches and
// refused if it does not.
import { createHash } from "node:crypto";
import { safeFetch, type SafeFetch } from "@turntable/net";
import type { GithubReleaseTarget, PublishContext, TargetResult } from "./types";

const ASSET_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const MAX_ASSET = 512 * 1024 * 1024;

interface Asset {
  id: number;
  name: string;
}
interface Release {
  id: number;
  draft: boolean;
  assets: Asset[];
}

export interface GithubReleaseOptions {
  api?: string;
  uploads?: string;
  fetch?: SafeFetch;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export type AssetPlan =
  | { ok: true; assets: { asset: string; file?: string }[] }
  | { ok: false; reason: string; detail: string };

/**
 * The assets a release would carry and where each comes from: the target's `assets` (a file under
 * its own path), EVERY file of each `assetArtifacts` artifact under its basename (a validated plain
 * name), the provenance, and the verified co-signatures. A name used twice is refused. Nothing is
 * read, so a dry run plans with it too.
 */
export function planAssets(
  t: GithubReleaseTarget,
  ctx: Pick<PublishContext, "filesOf" | "cosignatures">,
  hasProvenance: boolean,
): AssetPlan {
  const assets: { asset: string; file?: string }[] = [];
  const seen = new Set<string>();
  const add = (asset: string, file?: string): string | undefined => {
    if (seen.has(asset)) return asset;
    seen.add(asset);
    assets.push(file === undefined ? { asset } : { asset, file });
    return undefined;
  };
  for (const name of t.assets) {
    const dup = add(name, name);
    if (dup) return { ok: false, reason: "asset_name_collision", detail: dup };
  }
  // Every file of each named artifact, under its own basename: a plain name, never a path.
  for (const artifact of t.assetArtifacts ?? []) {
    const files = ctx.filesOf(artifact);
    if (files.length === 0) return { ok: false, reason: "artifact_empty", detail: artifact };
    for (const file of files) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      if (!ASSET_BASENAME.test(base))
        return { ok: false, reason: "bad_asset_name", detail: `${artifact}: ${file}` };
      const dup = add(base, file);
      if (dup) return { ok: false, reason: "asset_name_collision", detail: dup };
    }
  }
  if (t.provenanceAsset !== null) {
    if (!hasProvenance)
      return { ok: false, reason: "no_provenance", detail: "the lane signed nothing to attach" };
    const dup = add(t.provenanceAsset);
    if (dup) return { ok: false, reason: "asset_name_collision", detail: dup };
  }
  for (const c of ctx.cosignatures ?? []) {
    const dup = add(c.outputName);
    if (dup) return { ok: false, reason: "cosign_name_collision", detail: dup };
  }
  return { ok: true, assets };
}

export async function publishGithubRelease(
  key: string,
  t: GithubReleaseTarget,
  ctx: PublishContext,
  token: string,
  o: GithubReleaseOptions = {},
): Promise<TargetResult> {
  const api = (o.api ?? "https://api.github.com").replace(/\/+$/, "");
  const uploads = (o.uploads ?? "https://uploads.github.com").replace(/\/+$/, "");
  const f = o.fetch ?? safeFetch;
  const repo = ctx.repo;
  const base = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "turntable",
  };
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

  // What the release must hold: every asset by name and digest. The bytes are re-read here and
  // re-hashed, so what is attached is what the lane verified.
  const planned = planAssets(t, ctx, ctx.provenance !== undefined);
  if (!planned.ok) return refuse(planned.reason, planned.detail);
  const want = new Map<string, { bytes: Uint8Array; sha256: string }>();
  for (const p of planned.assets) {
    if (p.file === undefined) continue;
    const bytes = await ctx.readBytes(p.file);
    if (!bytes) return refuse("artifact_bytes_missing", p.file);
    const d = sha256(bytes);
    if (ctx.digests[p.file] !== d) return refuse("digest_mismatch", p.file);
    want.set(p.asset, { bytes, sha256: d });
  }
  if (t.provenanceAsset !== null) {
    const bytes = new TextEncoder().encode(ctx.provenance!);
    want.set(t.provenanceAsset, { bytes, sha256: sha256(bytes) });
  }
  // Lane-verified co-signatures go next to the provenance, under exactly their names.
  for (const c of ctx.cosignatures ?? []) {
    want.set(c.outputName, { bytes: c.signature, sha256: sha256(c.signature) });
  }
  const expected = Object.fromEntries([...want].map(([n, v]) => [n, v.sha256]));

  const json = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | undefined }> => {
    const res = await f(`${api}${path}`, {
      method,
      headers: { ...base, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 30_000,
      maxBytes: 4 * 1024 * 1024,
    });
    let parsed: T | undefined;
    try {
      parsed = (await res.json()) as T;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  };
  /** The digest of an attached asset, from the bytes GitHub serves. */
  const heldDigest = async (a: Asset): Promise<string> => {
    const res = await f(`${api}/repos/${repo}/releases/assets/${a.id}`, {
      headers: { ...base, accept: "application/octet-stream" },
      timeoutMs: 120_000,
      maxBytes: MAX_ASSET,
    });
    if (res.status !== 200) throw new Error(`reading asset ${a.name}: HTTP ${res.status}`);
    return sha256(new Uint8Array(await res.arrayBuffer()));
  };
  const lookup = async (): Promise<Release | undefined | { error: number }> => {
    const r = await json<Release>(
      "GET",
      `/repos/${repo}/releases/tags/${encodeURIComponent(ctx.tag)}`,
    );
    if (r.status === 404) return undefined;
    if (r.status !== 200 || !r.body) return { error: r.status };
    return r.body;
  };
  /** Names of wanted assets that are missing or differ in `rel`. */
  const differences = async (rel: Release): Promise<{ missing: string[]; different: string[] }> => {
    const missing: string[] = [];
    const different: string[] = [];
    for (const [name, w] of want) {
      const a = rel.assets.find((x) => x.name === name);
      if (!a) missing.push(name);
      else if ((await heldDigest(a)) !== w.sha256) different.push(name);
    }
    return { missing, different };
  };

  /** Names of assets the release holds that nobody asked for. */
  const extras = (rel: Release): string[] =>
    rel.assets.map((a) => a.name).filter((n) => !want.has(n));

  let rel = await lookup();
  if (rel && "error" in rel) return failed(`http_${rel.error}`, "reading the release");

  if (rel && !rel.draft) {
    // Published: matching is a success, anything else a refusal. Never modified.
    const d = await differences(rel);
    const more = extras(rel);
    if (d.missing.length === 0 && d.different.length === 0 && more.length === 0) {
      return { target: key, state: "already", facts: { release: rel.id, assets: expected } };
    }
    return refuse(
      "republish_mismatch",
      `the published release ${ctx.tag} differs: ${[...d.missing.map((n) => `${n} missing`), ...d.different.map((n) => `${n} differs`), ...more.map((n) => `${n} unexpected`)].join(", ")}`,
      { release: rel.id, ...(more.length > 0 ? { extras: more } : {}) },
    );
  }

  if (!rel) {
    const made = await json<Release>("POST", `/repos/${repo}/releases`, {
      tag_name: ctx.tag,
      name: ctx.tag,
      draft: true,
      prerelease: ctx.tag.includes("-"),
    });
    if (made.status !== 201 || !made.body)
      return failed(`http_${made.status}`, "creating the draft");
    rel = made.body;
  }
  const draft = rel as Release;

  for (const [name, w] of want) {
    const held = draft.assets.find((a) => a.name === name);
    if (held) {
      if ((await heldDigest(held)) === w.sha256) continue;
      // Our own draft holds something else under this name: replace it.
      const del = await json("DELETE", `/repos/${repo}/releases/assets/${held.id}`);
      if (del.status !== 204)
        return failed(`http_${del.status}`, `removing ${name} from the draft`);
    }
    const up = await f(
      `${uploads}/repos/${repo}/releases/${draft.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { ...base, "content-type": "application/octet-stream" },
        body: w.bytes,
        timeoutMs: 300_000,
        maxBytes: 1024 * 1024,
      },
    );
    if (up.status !== 201) return failed(`http_${up.status}`, `uploading ${name}`);
  }

  // What the draft now holds must be exactly what was sent, before anything is published.
  const after = await lookup();
  if (!after || "error" in after) return failed("lookup_failed", "re-reading the draft");
  // The set must be exactly what was asked for: an asset a job attached on top is not published
  // (the draft is left as it is, for a person to look at) and the names are audited.
  const more = extras(after);
  if (more.length > 0) {
    return refuse(
      "unexpected_assets",
      `the draft holds assets that were not asked for: ${more.join(", ")}`,
      { release: draft.id, extras: more },
    );
  }
  const d = await differences(after);
  if (d.missing.length > 0 || d.different.length > 0) {
    return refuse(
      "verify_failed",
      `the draft does not hold what was uploaded: ${[...d.missing, ...d.different].join(", ")}`,
      {
        release: draft.id,
      },
    );
  }

  const pub = await json("PATCH", `/repos/${repo}/releases/${draft.id}`, {
    draft: false,
    prerelease: ctx.tag.includes("-"),
  });
  if (pub.status !== 200) return failed(`http_${pub.status}`, "publishing the draft");
  return { target: key, state: "published", facts: { release: draft.id, assets: expected } };
}

/**
 * The draft release for a tag, created by the lane itself when there is none. Compat publishing
 * pins a job's upload rule to this release's id, so a job can never attach anything to a
 * published release. A release for the tag that is already published is refused.
 */
export async function ensureDraft(
  repo: string,
  tag: string,
  token: string,
  o: GithubReleaseOptions = {},
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  const api = (o.api ?? "https://api.github.com").replace(/\/+$/, "");
  const f = o.fetch ?? safeFetch;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "turntable",
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${api}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 30_000,
      maxBytes: 4 * 1024 * 1024,
    });
    let json: Release | undefined;
    try {
      json = (await res.json()) as Release;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  };
  const found = await call("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (found.status === 200 && found.json) {
    return found.json.draft
      ? { ok: true, id: found.json.id }
      : { ok: false, reason: "already_published" };
  }
  if (found.status !== 404) return { ok: false, reason: `http_${found.status}` };
  const made = await call("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    name: tag,
    draft: true,
    prerelease: tag.includes("-"),
  });
  return made.status === 201 && made.json
    ? { ok: true, id: made.json.id }
    : { ok: false, reason: `http_${made.status}` };
}
