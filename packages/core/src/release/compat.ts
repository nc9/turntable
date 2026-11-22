// Compat publishing: the project's own job runs `npm publish`, `docker push` or `gh release
// upload`, and the release proxy (hosted by the lane) attaches the credential to exactly the
// approved request. These are the rules the proxy is given for a release the lane has signed:
// each names one host, one package or repository, and the digests the lane attested, so a job can
// publish the approved bytes under the approved name and nothing else.
import { npmPath, type Rule } from "@longshore/proxy";
import type { GithubReleaseTarget, NpmTarget, OciTarget, PublishTarget } from "./publish/types";

/** The rule `secret` that means the lane's own GitHub write credential (not a vault secret). */
export const RELEASE_GITHUB_SECRET = "@release-github-token";

/** What the lane verified for the release. */
export interface CompatRelease {
  /** The pinned repository, `owner/name`. */
  repo: string;
  tag: string;
  /** The draft release the lane created for the tag: the only release a job may upload to. */
  githubDraftId?: number | undefined;
  /** Digests the lane attested, by artifact name (lower-case hex sha256). */
  digests: Readonly<Record<string, string>>;
}

const bearer = { type: "header", name: "Authorization", format: "Bearer {secret}" } as const;

function npmRules(key: string, t: NpmTarget, r: CompatRelease): Rule[] {
  const digest = r.digests[t.artifact];
  if (!digest) return [];
  return [
    {
      id: `${key}:npm`,
      host: "registry.npmjs.org",
      methods: ["GET", "PUT"],
      pathPrefix: npmPath(t.package),
      npmPackage: t.package,
      inject: bearer,
      secret: t.secret,
      forwardHeaders: ["npm-auth-type", "npm-command", "npm-scope"],
      bodyCheck: { type: "npm-publish", digests: [digest] },
    },
  ];
}

function githubRules(key: string, t: GithubReleaseTarget, r: CompatRelease): Rule[] {
  if (t.assets.some((a) => !r.digests[a]) || r.githubDraftId === undefined) return [];
  const base = `/repos/${r.repo}/releases`;
  const common = {
    inject: bearer,
    secret: RELEASE_GITHUB_SECRET,
    forwardHeaders: ["x-github-api-version"],
  };
  return [
    // Read releases and their assets (to find the draft, and what is attached).
    { id: `${key}:read`, host: "api.github.com", methods: ["GET"], pathPrefix: base, ...common },
    // Attach assets to the one draft the lane created, and to nothing else. A job creates no
    // release and changes none: the lane checks the draft and publishes it.
    {
      id: `${key}:upload`,
      host: "uploads.github.com",
      methods: ["POST"],
      pathPrefix: `${base}/${r.githubDraftId}/assets`,
      pathExact: true,
      ...common,
    },
  ];
}

function ociRules(key: string, t: OciTarget, r: CompatRelease): Rule[] {
  const digest = r.digests[t.manifest];
  if (!digest) return [];
  const repo = `/v2/${t.repository}`;
  const inject = {
    type: "oci-bearer",
    username: t.username,
    scope: `repository:${t.repository}:push,pull`,
  } as const;
  const common = { host: t.registry, inject, secret: t.secret };
  return [
    // The version ping: a client asks `/v2/` before anything else.
    {
      id: `${key}:ping`,
      methods: ["GET"],
      pathPrefix: "/v2/",
      pathExact: true,
      ...common,
    },
    // Blobs are content-addressed: pushing one is harmless, so they are not pinned.
    {
      id: `${key}:blobs`,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH"],
      pathPrefix: `${repo}/blobs`,
      ...common,
    },
    {
      id: `${key}:manifests-read`,
      methods: ["GET", "HEAD"],
      pathPrefix: `${repo}/manifests`,
      ...common,
    },
    // The manifest decides what a tag means: only the attested one, only under the approved references.
    ...[...t.tags, `sha256:${digest}`].map((ref, i) => ({
      id: `${key}:manifest-${i}`,
      methods: ["PUT"],
      pathPrefix: `${repo}/manifests/${ref}`,
      pathExact: true,
      bodyCheck: { type: "sha256" as const, digests: [digest] },
      ...common,
    })),
  ];
}

/** The rules for one declared target in compat mode. Empty when an artifact it names was not attested. */
export function compatRules(key: string, t: PublishTarget, r: CompatRelease): Rule[] {
  if (t.mode !== "compat") return [];
  if (t.kind === "npm") return npmRules(key, t, r);
  if (t.kind === "github-release") return githubRules(key, t, r);
  return ociRules(key, t, r);
}
