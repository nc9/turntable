import {
  ARTIFACT_NAME,
  DIST_TAG,
  NPM_NAME,
  SECRET_NAME,
  type GithubReleaseTarget,
  type NpmTarget,
  type PublishTarget,
} from "./types";

export const TARGET_KEY = /^[a-z][a-z0-9-]{0,31}$/;

export class PublishConfigError extends Error {}

const need = (cond: boolean, why: string): void => {
  if (!cond) throw new PublishConfigError(why);
};

/** Checks a declaration read from the CLI or from the lane's file; throws on anything off. */
export function parseTarget(raw: unknown): PublishTarget {
  need(typeof raw === "object" && raw !== null && !Array.isArray(raw), "a target is an object");
  const o = raw as Record<string, unknown>;
  if (o.kind === "npm") {
    const t: NpmTarget = {
      kind: "npm",
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
    need(DIST_TAG.test(t.tag), "tag must be a plain dist-tag");
    need(t.access === "public" || t.access === "restricted", "access must be public or restricted");
    need(SECRET_NAME.test(t.secret), "secret must name a release-class vault secret");
    return t;
  }
  if (o.kind === "github-release") {
    const assets = Array.isArray(o.assets) ? o.assets.map(String) : [];
    need(assets.length > 0 && assets.length <= 50, "assets must list 1 to 50 recorded artifacts");
    for (const a of assets)
      need(ARTIFACT_NAME.test(a) && !a.split("/").includes(".."), `bad asset name ${a}`);
    need(new Set(assets).size === assets.length, "assets must not repeat");
    const prov = o.provenanceAsset === undefined ? "provenance.intoto.json" : o.provenanceAsset;
    need(
      prov === null ||
        (typeof prov === "string" && ARTIFACT_NAME.test(prov) && !assets.includes(prov)),
      "provenanceAsset must be a plain name that is not an asset, or null",
    );
    const t: GithubReleaseTarget = {
      kind: "github-release",
      assets,
      provenanceAsset: prov as string | null,
    };
    return t;
  }
  throw new PublishConfigError("kind must be npm or github-release");
}
