// `turntable approvals approve-release`: the offline-key flow for a release approval (#483).
// A release is approved over the digest of its artifact manifest (`turntable.approve_release.v2`),
// so this fetches the server's v2 challenge, recomputes the manifest digest from the artifacts it
// lists, prints them, and signs only if the person confirms and everything agrees. The key never
// leaves the machine; the signature is the credential for the submit (no token is sent).
import { createHttpClient, type SafeFetch } from "@turntable/net";
import { baseString } from "../channel/api";
import { manifestSha256, ManifestError, type ManifestArtifact } from "../release/manifest";
import { signEd25519 } from "./keys";
import {
  canonicalStatement,
  RELEASE_STATEMENT_TYPE,
  releaseStatementSchema,
  type ReleaseStatement,
} from "./statement";

/** The v2 challenge as the server returns it (release_approval_challenge). */
export type ReleaseChallengeWire = {
  statement: unknown;
  canonical: string;
  manifest_sha256: string;
  artifacts: ManifestArtifact[];
};

export const RELEASE_REQUIRES_V2_MESSAGE =
  "this is a release: update the client, approvals now bind the release manifest";

/** A server refusal in words for a person; the v1-for-release refusal gets the clear message. */
export const refusalText = (message: string): string =>
  message.includes("release_requires_v2") ? RELEASE_REQUIRES_V2_MESSAGE : message;

const sizeText = (n: number): string => (n < 1000 ? `${n} B` : `${(n / 1e6).toFixed(2)} MB`);

/** The manifest, as shown before anything is signed. */
export function manifestSummary(
  artifacts: readonly ManifestArtifact[],
  manifest: string,
  extra: Record<string, string> = {},
): string {
  const lines = [...artifacts]
    .toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((a) => `  ${a.name}  ${sizeText(a.size)} (${a.size} bytes)\n    sha256 ${a.sha256}`);
  const head = Object.entries(extra).map(([k, v]) => `${k.padEnd(16)} ${v}`);
  return [
    ...head,
    `release manifest: ${artifacts.length} ${artifacts.length === 1 ? "artifact" : "artifacts"}`,
    ...lines,
    `manifest digest   ${manifest}`,
  ].join("\n");
}

/**
 * Why the challenge must not be signed, or null. The artifacts shown must hash to the digest in
 * the statement, the statement must be a v2 release statement, and the text signed must be the
 * canonical form of exactly that statement.
 */
export function challengeProblem(
  c: ReleaseChallengeWire,
  expect: { runId: string; approver: string },
): string | null {
  const parsed = releaseStatementSchema.safeParse(c.statement);
  if (!parsed.success) return `the statement is not a ${RELEASE_STATEMENT_TYPE} statement`;
  const st = parsed.data;
  if (st.run_id !== expect.runId) return "the statement is for another run";
  if (st.approver !== expect.approver) return "the statement is for another approver key";
  if (c.canonical !== canonicalStatement(st))
    return "the text to sign is not the canonical form of the statement";
  let digest: string;
  try {
    digest = manifestSha256(c.artifacts);
  } catch (e) {
    if (e instanceof ManifestError) return `the manifest is not valid: ${e.message}`;
    throw e;
  }
  if (digest !== st.manifest_sha256 || digest !== c.manifest_sha256)
    return "the artifacts listed do not hash to the manifest digest in the statement";
  return null;
}

async function post<T>(f: SafeFetch, url: string, body: unknown, token: string | null): Promise<T> {
  const res = await f(new URL(url), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON
    }
    throw new Error(refusalText(message));
  }
  return (await res.json()) as T;
}

export type ReleaseApprovalResult = {
  run_id: string;
  environment: string;
  approvals: number;
  required: number;
  released_jobs: number;
  state: string;
  manifest_sha256: string;
};

/**
 * Fetches the release challenge, prints the manifest, asks `confirm`, signs the canonical text
 * with the ed25519 key and submits it to approve_release. Throws with a message for a person.
 */
export async function approveReleaseRemote(o: {
  baseUrl: URL;
  org: string;
  project: string;
  runId: string;
  approver: string;
  privatePem: string;
  token: string;
  /** Where the summary goes (stderr in the command). */
  print: (text: string) => void;
  /** Asked once, after the manifest is printed. */
  confirm: () => Promise<boolean>;
  fetch?: SafeFetch;
}): Promise<ReleaseApprovalResult> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const base = `${baseString(o.baseUrl)}/api/v1`;
  const c = await post<ReleaseChallengeWire>(
    f,
    `${base}/approvals/release-challenge`,
    { run_id: o.runId, approver: o.approver, org: o.org, project: o.project },
    o.token,
  );
  const problem = challengeProblem(c, { runId: o.runId, approver: o.approver });
  if (problem) throw new Error(`nothing was signed: ${problem}`);
  const st = releaseStatementSchema.parse(c.statement) as ReleaseStatement;
  o.print(
    manifestSummary(c.artifacts, st.manifest_sha256, {
      "org/project": `${st.org}/${st.project}`,
      run: st.run_id,
      commit: st.head_sha,
      environment: st.environment,
      "valid until": new Date(st.expires_at).toISOString(),
    }),
  );
  if (!(await o.confirm())) throw new Error("not confirmed: nothing was signed");
  const signature = { kind: "ed25519" as const, signature: signEd25519(o.privatePem, c.canonical) };
  // The signature is the credential: no token is sent.
  return post<ReleaseApprovalResult>(
    f,
    `${base}/approvals/release`,
    { statement: st, signature },
    null,
  );
}

/**
 * For `approvals sign`: when the text being signed came with its manifest (the
 * release_approval_challenge response), check the artifacts hash to the digest and return the
 * summary to show. Returns null when it is not a release challenge; throws if it does not agree.
 */
export function releaseSignPreview(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const j = parsed as Partial<ReleaseChallengeWire>;
  if (!Array.isArray(j.artifacts) || typeof j.canonical !== "string") return null;
  const st = releaseStatementSchema.safeParse(j.statement);
  if (!st.success) throw new Error(`the statement is not a ${RELEASE_STATEMENT_TYPE} statement`);
  const problem = challengeProblem(j as ReleaseChallengeWire, {
    runId: st.data.run_id,
    approver: st.data.approver,
  });
  if (problem) throw new Error(`nothing was signed: ${problem}`);
  return manifestSummary(j.artifacts, st.data.manifest_sha256);
}
