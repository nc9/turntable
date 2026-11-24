// Approving a release (#483). The project's release environment is approved with a v2 statement
// that binds the digest of the artifacts the release lane will sign, so the page shows that
// manifest and signs nothing the screen does not show. Pure helpers: the page and the tests share
// them.
import type { ReleaseArtifact, ReleaseStatement } from "@/api/types";
import { statementMismatch } from "@/lib/approval-statement";
import { formatSize } from "@/lib/format";

export const MANIFEST_DOMAIN = "turntable.release_manifest.v1";

/** What the page asks the server for, by operation, for one environment of one run. */
export type ChallengeRequest =
  | { op: "approval_challenge"; path: string; body: Record<string, unknown> }
  | { op: "release_approval_challenge"; path: string; body: Record<string, unknown> };

/** The challenge to ask for: the v2 release challenge for a release environment, else v1. */
export function challengeRequest(a: {
  release: boolean;
  runId: string;
  environment: string;
  approver: string;
  org: string;
  project: string;
}): ChallengeRequest {
  // The release challenge takes no environment: the server uses the project's release environment.
  return a.release
    ? {
        op: "release_approval_challenge",
        path: "/approvals/release-challenge",
        body: { run_id: a.runId, approver: a.approver, org: a.org, project: a.project },
      }
    : {
        op: "approval_challenge",
        path: "/approvals/challenge",
        body: {
          run_id: a.runId,
          environment: a.environment,
          approver: a.approver,
          org: a.org,
          project: a.project,
        },
      };
}

/** The submit operation that matches the challenge. The signature is the credential for both. */
export const submitPath = (release: boolean): string =>
  release ? "/approvals/release" : "/approvals";

/** The release environment of a run's approval status, if the server marks one as waiting. */
export function releaseEnvironment(
  environments: { environment: string; waiting: boolean; release: boolean }[],
  preferred?: string,
): string | null {
  const waiting = environments.filter((e) => e.waiting && e.release);
  return (waiting.find((e) => e.environment === preferred) ?? waiting[0])?.environment ?? null;
}

const SHA256 = /^[0-9a-f]{64}$/;

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The canonical manifest text, as the server computes it (release/manifest.ts). */
export function manifestText(artifacts: readonly ReleaseArtifact[]): string {
  const lines = [...artifacts]
    .toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((a) => `${a.sha256} ${a.size} ${a.name}\n`);
  return `${MANIFEST_DOMAIN}\n${lines.join("")}`;
}

/** sha256 hex of the canonical manifest text. */
export async function manifestDigest(artifacts: readonly ReleaseArtifact[]): Promise<string> {
  const bytes = new TextEncoder().encode(manifestText(artifacts));
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Why the statement must not be signed, or null. The statement is the server's word; the manifest
 * on screen has to hash to the digest in it, and the rest has to be what the page showed.
 */
export async function releaseMismatch(
  statement: ReleaseStatement,
  artifacts: readonly ReleaseArtifact[],
  shown: {
    runId: string;
    headSha: string;
    workflowHash: string;
    environment: string;
    approver: string;
  },
): Promise<string | null> {
  if (statement.type !== "turntable.approve_release.v2")
    return "the statement is not a release approval";
  const base = statementMismatch(statement, shown);
  if (base) return base;
  if (artifacts.length === 0) return "the release has no artifact to approve";
  if (!SHA256.test(statement.manifest_sha256)) return "the manifest digest is malformed";
  if (artifacts.some((a) => !SHA256.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 0))
    return "an artifact in the manifest is malformed";
  if ((await manifestDigest(artifacts)) !== statement.manifest_sha256)
    return "the artifacts shown do not match the manifest digest in the statement";
  return null;
}

export type ManifestRow = { name: string; size: string; sha256: string };

/** The rows the page shows: one per artifact, sorted as the manifest is, with a readable size. */
export function manifestRows(artifacts: readonly ReleaseArtifact[]): ManifestRow[] {
  return [...artifacts]
    .toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((a) => ({
      name: a.name,
      size: `${formatSize(a.size)} (${a.size} bytes)`,
      sha256: a.sha256,
    }));
}

/** The server's refusal of a v1 approval for the release environment, in words for a person. */
export const RELEASE_REQUIRES_V2_MESSAGE =
  "This is a release: update the client. Approvals now bind the release manifest.";

/** Maps a server refusal to the message to show; other messages pass through unchanged. */
export function approvalErrorMessage(message: string): string {
  return message.includes("release_requires_v2") ? RELEASE_REQUIRES_V2_MESSAGE : message;
}
