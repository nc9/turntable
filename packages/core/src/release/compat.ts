// Compat publishing: the project's own job runs `npm publish`, `docker push` or `gh release
// upload`, and the release proxy (hosted by the lane) attaches the credential to exactly the
// approved request. These are the rules the proxy is given for a release the lane has signed:
// each names one host, one package or repository, and the digests the lane attested, so a job can
// publish the approved bytes under the approved name and nothing else.
import { npmPath, type Rule } from "@turntable/proxy";
import { resolveDistTag } from "./publish/dist-tag";
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
  /**
   * The package.json of each npm tarball the lane read and verified, by artifact name. The
   * publish document a job may send is derived from it; without it there is no npm rule.
   */
  npmManifests?: Readonly<Record<string, Record<string, unknown>>> | undefined;
  /** The README files of each of those tarballs, by file name, for the same artifact names. */
  npmReadmes?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  /** The commit the tag points at, the only `gitHead` a publish document may carry. */
  sha?: string | undefined;
  /** Digests the lane attested, by artifact name (lower-case hex sha256). */
  digests: Readonly<Record<string, string>>;
  /**
   * True when this is the project's newest approved release. A mutable image tag (`latest`, `1.2`)
   * may only be pointed at this release's image if it is; otherwise an older approved release
   * could be used to roll the tag back. Absent means false.
   */
  newest?: boolean | undefined;
}

/** The references of an image that name this release and nothing else: the tag, with or without `v`. */
function isVersionRef(ref: string, tag: string): boolean {
  return ref === tag || ref === tag.replace(/^v/, "");
}

const bearer = { type: "header", name: "Authorization", format: "Bearer {secret}" } as const;

function npmRules(key: string, t: NpmTarget, r: CompatRelease): Rule[] {
  const digest = r.digests[t.artifact];
  const manifest = r.npmManifests?.[t.artifact];
  if (!digest || !manifest || typeof manifest.version !== "string") return [];
  const dist = resolveDistTag(t.tag, manifest.version);
  // No rule for a tag that cannot be derived: the job gets no credential for this publish.
  if (!dist.ok) return [];
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
      // The whole document, not just the bytes: the lane derives it from the tarball's own
      // package.json, so a job cannot publish other metadata, dist-tags or versions.
      bodyCheck: {
        type: "npm-publish",
        digests: [digest],
        expect: {
          name: t.package,
          version: manifest.version,
          tag: dist.tag,
          access: t.access,
          manifest,
          readmes: r.npmReadmes?.[t.artifact] ?? {},
          gitHead: r.sha,
        },
      },
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
    ...(t.realmHost ? { realmHost: t.realmHost } : {}),
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
    // The endpoints of a push, each anchored to its own shape. A prefix like `<repo>/blobs` would
    // also match a repository named `<repo>/blobs/x` and its manifests; these cannot.
    // Starting an upload (and mounting a blob, which is a POST with a query).
    {
      id: `${key}:blob-upload-start`,
      methods: ["POST"],
      pathPrefix: `${repo}/blobs/uploads/`,
      pathExact: true,
      ...common,
    },
    // Continuing and finishing an upload session: one segment, the session id.
    {
      id: `${key}:blob-upload`,
      methods: ["PATCH", "PUT"],
      pathPrefix: `${repo}/blobs/uploads`,
      pathShape: `${repo}/blobs/uploads/*`,
      ...common,
    },
    // Reading a blob by digest. Blobs are content-addressed: pushing one is harmless.
    {
      id: `${key}:blob-read`,
      methods: ["GET", "HEAD"],
      pathPrefix: `${repo}/blobs`,
      pathShape: `${repo}/blobs/{sha256}`,
      ...common,
    },
    {
      id: `${key}:manifests-read`,
      methods: ["GET", "HEAD"],
      pathPrefix: `${repo}/manifests`,
      pathShape: `${repo}/manifests/*`,
      ...common,
    },
    // The manifest decides what a tag means: only the attested one, only under the approved
    // references. The release's own version tag and the digest always; a mutable tag only when
    // this is the project's newest approved release.
    ...[...t.tags, `sha256:${digest}`]
      .filter((ref) => ref.startsWith("sha256:") || isVersionRef(ref, r.tag) || r.newest === true)
      .map((ref, i) => ({
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
