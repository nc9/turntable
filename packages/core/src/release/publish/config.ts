import { isIP } from "node:net";
import {
  ARTIFACT_NAME,
  DIST_TAG,
  NPM_NAME,
  OCI_REPOSITORY,
  OCI_TAG,
  REGISTRY_HOST,
  SECRET_NAME,
  type GithubReleaseTarget,
  type NpmTarget,
  type OciTarget,
  type PublishMode,
  type PublishTarget,
} from "./types";

export const TARGET_KEY = /^[a-z][a-z0-9-]{0,31}$/;

export class PublishConfigError extends Error {}

const need = (cond: boolean, why: string): void => {
  if (!cond) throw new PublishConfigError(why);
};

const modeOf = (o: Record<string, unknown>): PublishMode => {
  const m = o.mode ?? "strict";
  need(m === "strict" || m === "compat", "mode must be strict or compat");
  return m as PublishMode;
};

/** Checks a declaration read from the CLI or from the lane's file; throws on anything off. */
export function parseTarget(raw: unknown): PublishTarget {
  need(typeof raw === "object" && raw !== null && !Array.isArray(raw), "a target is an object");
  const o = raw as Record<string, unknown>;
  if (o.kind === "npm") {
    const t: NpmTarget = {
      kind: "npm",
      mode: modeOf(o),
      package: String(o.package ?? ""),
      artifact: String(o.artifact ?? ""),
      tag: String(o.tag ?? "latest"),
      access: (o.access ?? "public") as NpmTarget["access"],
      secret: String(o.secret ?? ""),
    };
    need(NPM_NAME.test(t.package) && t.package.length <= 214, "package must be a valid npm name");
    need(
      ARTIFACT_NAME.test(t.artifact) && !t.artifact.split("/").includes(".."),
      "artifact must be a recorded artifact name",
    );
    need(t.tag === "auto" || DIST_TAG.test(t.tag), "tag must be a plain dist-tag or auto");
    need(t.access === "public" || t.access === "restricted", "access must be public or restricted");
    need(SECRET_NAME.test(t.secret), "secret must name a release-class vault secret");
    return t;
  }
  if (o.kind === "github-release") {
    const assets = Array.isArray(o.assets) ? o.assets.map(String) : [];
    const assetArtifacts = Array.isArray(o.assetArtifacts) ? o.assetArtifacts.map(String) : [];
    need(
      assets.length + assetArtifacts.length > 0 &&
        assets.length <= 50 &&
        assetArtifacts.length <= 20,
      "list 1 to 50 assets (files) and/or 1 to 20 asset_artifacts (artifacts whose every file is attached)",
    );
    for (const a of assets)
      need(ARTIFACT_NAME.test(a) && !a.split("/").includes(".."), `bad asset name ${a}`);
    need(new Set(assets).size === assets.length, "assets must not repeat");
    for (const a of assetArtifacts)
      need(ARTIFACT_NAME.test(a) && !a.split("/").includes(".."), `bad asset artifact name ${a}`);
    need(new Set(assetArtifacts).size === assetArtifacts.length, "asset_artifacts must not repeat");
    const prov = o.provenanceAsset === undefined ? "provenance.intoto.json" : o.provenanceAsset;
    need(
      prov === null ||
        (typeof prov === "string" && ARTIFACT_NAME.test(prov) && !assets.includes(prov)),
      "provenanceAsset must be a plain name that is not an asset, or null",
    );
    const t: GithubReleaseTarget = {
      kind: "github-release",
      mode: modeOf(o),
      assets,
      ...(assetArtifacts.length > 0 ? { assetArtifacts } : {}),
      provenanceAsset: prov as string | null,
    };
    return t;
  }
  if (o.kind === "oci-image") {
    need(modeOf(o) === "compat", "an image is published in compat mode only");
    const tags = Array.isArray(o.tags) ? o.tags.map(String) : [];
    const t: OciTarget = {
      kind: "oci-image",
      mode: "compat",
      registry: String(o.registry ?? ""),
      repository: String(o.repository ?? ""),
      manifest: String(o.manifest ?? ""),
      tags,
      username: String(o.username ?? ""),
      ...(o.realmHost !== undefined ? { realmHost: String(o.realmHost) } : {}),
      secret: String(o.secret ?? ""),
    };
    if (t.realmHost !== undefined)
      need(
        REGISTRY_HOST.test(t.realmHost) && isIP(t.realmHost) === 0,
        "realmHost must be one lower-case hostname (no wildcard, no address)",
      );
    need(REGISTRY_HOST.test(t.registry), "registry must be a lower-case hostname");
    need(
      OCI_REPOSITORY.test(t.repository) && t.repository.length <= 200,
      "repository must be a lower-case owner/name",
    );
    need(
      ARTIFACT_NAME.test(t.manifest) && !t.manifest.split("/").includes(".."),
      "manifest must be a recorded artifact name",
    );
    need(
      tags.length > 0 && tags.length <= 10 && tags.every((x) => OCI_TAG.test(x)),
      "tags must list 1 to 10 plain references",
    );
    need(
      /^[\x21-\x7e]{1,64}$/.test(t.username) && !t.username.includes(":"),
      "username must be printable, no colon",
    );
    need(SECRET_NAME.test(t.secret), "secret must name a release-class vault secret");
    return t;
  }
  throw new PublishConfigError("kind must be npm, github-release or oci-image");
}
