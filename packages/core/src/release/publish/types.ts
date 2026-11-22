// Strict publishing: after the release lane has verified and signed a release, it publishes the
// bytes it verified to the project's declared targets itself. The declaration lives in the lane's
// own file (never in the workflow, which a pull request can edit), and the credentials are
// release-class secrets only the lane can open.
import type { SafeFetch } from "@longshore/net";

export const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
export const DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
export const REGISTRY_HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const OCI_REPOSITORY = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
export const OCI_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;

/**
 * Who performs the publish. `strict` (default): the lane, from the bytes it verified. `compat`:
 * the project's own job, through the lane's release proxy, which attaches the credential only to
 * the approved request; the lane then checks (and finishes) the result.
 */
export type PublishMode = "strict" | "compat";

/** `npm publish` of one recorded tarball. */
export interface NpmTarget {
  kind: "npm";
  mode: PublishMode;
  /** The package name; the tarball's own package.json must say exactly this. */
  package: string;
  /** The recorded artifact that is the `npm pack` tarball. */
  artifact: string;
  tag: string;
  access: "public" | "restricted";
  /** The release-class vault secret holding the registry token. */
  secret: string;
}

/** A GitHub Release for the tag, with the recorded artifacts (and the provenance) as assets. */
export interface GithubReleaseTarget {
  kind: "github-release";
  mode: PublishMode;
  /** Recorded artifacts to attach. */
  assets: string[];
  /** Name of the signed provenance asset; null to attach none. */
  provenanceAsset: string | null;
}

/**
 * A container image on an OCI registry. Compat mode only: the job pushes, the release proxy does
 * the registry's token exchange and pins the manifest to the digest the lane attested.
 */
export interface OciTarget {
  kind: "oci-image";
  mode: "compat";
  /** Registry host, for example `ghcr.io`. */
  registry: string;
  /** `owner/name`, lower-case. */
  repository: string;
  /** The recorded artifact that is the image manifest (JSON); its digest is the one pinned. */
  manifest: string;
  /** References the manifest may be pushed under, for example the version. */
  tags: string[];
  /** The registry user for the token exchange. */
  username: string;
  /**
   * The one host whose token endpoint may be called, when it is not the registry's own (Docker
   * Hub's `auth.docker.io`). An exact hostname; the endpoint must be https on that host.
   */
  realmHost?: string | undefined;
  /** The release-class vault secret (the registry credential). */
  secret: string;
}

export type PublishTarget = NpmTarget | GithubReleaseTarget | OciTarget;

export type TargetState = "published" | "already" | "refused" | "failed" | "pending";

export interface TargetResult {
  /** The target's key in the project's declaration. */
  target: string;
  state: TargetState;
  /** A short code: `republish_mismatch`, `version_tag_mismatch`, `http_403`, ... */
  reason?: string;
  detail?: string;
  /** What was done and seen, for the audit trail. Never a credential. */
  facts?: Record<string, unknown>;
}

/** The release being published: only what the lane verified. */
export interface PublishContext {
  scope: { orgId: string; projectId: string };
  requestId: string;
  repo: string;
  tag: string;
  /** Recomputed by the lane from the bytes; publishers hash again before sending. */
  digests: Readonly<Record<string, string>>;
  readBytes(name: string): Promise<Uint8Array | undefined>;
  /** The signed provenance envelope, as JSON text. */
  provenance: string | undefined;
}

export interface PublishCredentials {
  /** A release-class secret by name, for a destination host. Undefined when it is not usable. */
  secret(
    scope: { orgId: string; projectId: string },
    name: string,
    destination: string,
    tag: string,
    requestId: string,
  ): Promise<string | undefined>;
  /** The lane's own GitHub write credential for publishing releases. */
  githubToken(): Promise<string | undefined>;
}

export interface PublishWiring {
  credentials: PublishCredentials;
  fetch?: SafeFetch;
  /** Default https://registry.npmjs.org (tests point it elsewhere). */
  npmRegistry?: string;
  githubApi?: string;
  githubUploads?: string;
}
