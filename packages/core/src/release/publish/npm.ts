// npm: publishes the recorded tarball the lane verified, with the registry token only the lane
// can open. It builds the same request `npm publish` does (libnpmpublish's document), from the
// bytes, so nothing the workflow wrote decides what is published.
import { createHash } from "node:crypto";
import { safeFetch, type SafeFetch } from "@turntable/net";
import { tarEntries, tarEntry } from "./tar";
import type { NpmTarget, PublishContext, TargetResult } from "./types";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const MAX_PACKUMENT = 16 * 1024 * 1024;

/** `@scope/name` as a path segment: the slash is sent as %2F, as npm does. */
export const escapedName = (name: string): string => name.replace("/", "%2F");

export const integrityOf = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export interface NpmOptions {
  registry?: string;
  fetch?: SafeFetch;
}

/**
 * What a tarball is, from its own package.json: the name must be the target's, the version a
 * semantic version equal to the tag, and the package not private. Used for the lane's own publish
 * and to derive the document a compat publish must send.
 */
export function inspectNpmTarball(
  bytes: Uint8Array,
  pkg: string,
  tag: string,
):
  | {
      ok: true;
      version: string;
      manifest: Record<string, unknown>;
      /** README files at the top of the tarball, by file name. */
      readmes: Record<string, string>;
    }
  | { ok: false; reason: string; detail?: string } {
  const raw = tarEntry(bytes, "package/package.json");
  if (!raw)
    return {
      ok: false,
      reason: "not_an_npm_tarball",
      detail: "no package/package.json in the artifact",
    };
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not_an_npm_tarball", detail: "package.json is not JSON" };
  }
  const { name, version } = manifest;
  if (name !== pkg)
    return {
      ok: false,
      reason: "package_mismatch",
      detail: `the tarball is ${String(name)}, the target says ${pkg}`,
    };
  if (typeof version !== "string" || !VERSION.test(version))
    return {
      ok: false,
      reason: "bad_version",
      detail: "the tarball's version is not a semantic version",
    };
  if (manifest.private === true) return { ok: false, reason: "private_package" };
  // The release is the tag: v1.2.3 publishes version 1.2.3, never another.
  if (version !== tag.replace(/^v/, ""))
    return {
      ok: false,
      reason: "version_tag_mismatch",
      detail: `the tarball is ${version}, the tag is ${tag}`,
    };
  const readmes: Record<string, string> = {};
  for (const [n, b] of tarEntries(bytes, (x) => /^package\/readme(\.[^./]*)?$/i.test(x))) {
    readmes[n.slice("package/".length)] = new TextDecoder().decode(b);
  }
  return { ok: true, version, manifest, readmes };
}

/**
 * The tarball a strict npm target publishes: the single `.tgz` file of the named ARTIFACT. An
 * artifact that is one raw file, or a name that is itself a file of the release, is that file
 * (the older meaning of `artifact`).
 */
export function npmTarballOf(
  ctx: Pick<PublishContext, "filesOf" | "digests">,
  artifact: string,
): { ok: true; file: string } | { ok: false; reason: string; detail: string } {
  const files = ctx.filesOf(artifact);
  if (files.length === 1 && files[0] === artifact) return { ok: true, file: artifact };
  if (files.length > 0) {
    const tgz = files.filter((f) => f.endsWith(".tgz"));
    if (tgz.length === 1) return { ok: true, file: tgz[0]! };
    return {
      ok: false,
      reason: tgz.length === 0 ? "no_tarball" : "ambiguous_tarball",
      detail: `${artifact} holds ${tgz.length} .tgz files, expected exactly one`,
    };
  }
  if (artifact in ctx.digests) return { ok: true, file: artifact };
  return { ok: false, reason: "artifact_bytes_missing", detail: artifact };
}

export async function publishNpm(
  key: string,
  t: NpmTarget,
  ctx: PublishContext,
  token: string,
  o: NpmOptions = {},
): Promise<TargetResult> {
  const registry = (o.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const f = o.fetch ?? safeFetch;
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

  const found = npmTarballOf(ctx, t.artifact);
  if (!found.ok) return refuse(found.reason, found.detail);
  const file = found.file;
  const bytes = await ctx.readBytes(file);
  if (!bytes) return refuse("artifact_bytes_missing", file);
  // The bytes sent are the bytes the lane verified.
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (ctx.digests[file] !== sha) return refuse("digest_mismatch", file);

  const insp = inspectNpmTarball(bytes, t.package, ctx.tag);
  if (!insp.ok) return refuse(insp.reason, insp.detail);
  const { version, manifest } = insp;

  const integrity = integrityOf(bytes);
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const url = `${registry}/${escapedName(t.package)}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "user-agent": "turntable",
  };
  const facts = { package: t.package, version, integrity, registry, tag: t.tag };

  /** The published version's integrity, "none" when there is no such version. */
  const existing = async (): Promise<string | "none" | { error: number }> => {
    const res = await f(url, { headers, timeoutMs: 30_000, maxBytes: MAX_PACKUMENT });
    if (res.status === 404) return "none";
    if (res.status !== 200) return { error: res.status };
    const doc = (await res.json()) as {
      versions?: Record<string, { dist?: { integrity?: string } }>;
    };
    const v = doc.versions?.[version];
    if (!v) return "none";
    return v.dist?.integrity ?? "unknown";
  };

  const before = await existing();
  if (typeof before === "object") return failed(`http_${before.error}`, "reading the package");
  if (before !== "none") {
    // The version exists: fine if it is exactly these bytes, never an overwrite.
    return before === integrity
      ? { target: key, state: "already", facts }
      : refuse("republish_mismatch", `${t.package}@${version} exists with different bytes`, {
          ...facts,
          published: before,
        });
  }

  const tarballName = `${t.package}-${version}.tgz`;
  const doc = {
    _id: t.package,
    name: t.package,
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    "dist-tags": { [t.tag]: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${t.package}@${version}`,
        dist: {
          shasum,
          integrity,
          tarball: `${registry}/${t.package}/-/${tarballName}`,
        },
      },
    },
    access: t.access,
    _attachments: {
      [tarballName]: {
        content_type: "application/octet-stream",
        data: Buffer.from(bytes).toString("base64"),
        length: bytes.length,
      },
    },
  };
  const res = await f(url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(doc),
    timeoutMs: 120_000,
    maxBytes: 1024 * 1024,
  });
  if (res.status === 200 || res.status === 201) {
    return { target: key, state: "published", facts };
  }
  if (res.status === 409) {
    // Somebody (a retry, a concurrent lane) published it first: the same bytes are fine.
    const now = await existing();
    if (now === integrity) return { target: key, state: "already", facts };
    return refuse("republish_mismatch", `${t.package}@${version} appeared with other bytes`, facts);
  }
  return failed(`http_${res.status}`, "the registry refused the publish");
}
