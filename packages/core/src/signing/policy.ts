// The one function that decides whether the service may sign. Pure: everything it needs is passed
// in by the service, which loaded it from what the server stored, never from the caller.
import { isReleaseRef } from "../trust";

export type SigningDenial =
  | "unknown_run"
  | "run_not_successful"
  | "not_release_class"
  | "ref_not_a_release_ref"
  | "no_signing_key"
  | "no_repo"
  | "no_artifacts"
  | "artifact_not_recorded"
  | "no_approval"
  | "no_backend";

export interface SigningFacts {
  /** The run's stored class (`runs.trust`), undefined when it has none. */
  klass: string | undefined;
  status: string;
  ref: string;
  repo: string | null;
  releaseRefs: readonly string[];
  signingKey: string | null;
  requested: readonly string[];
  /** Names found in the artifact store for this run. */
  recorded: readonly string[];
  approvalOk: boolean;
}

export type SigningDecision = { ok: true } | { ok: false; reason: SigningDenial; detail?: string };

/** Order matters: the cheapest and most telling refusal first. */
export function decideSigning(f: SigningFacts): SigningDecision {
  if (f.klass !== "release") return { ok: false, reason: "not_release_class" };
  if (f.status !== "success") return { ok: false, reason: "run_not_successful" };
  if (!isReleaseRef(f.ref, f.releaseRefs)) return { ok: false, reason: "ref_not_a_release_ref" };
  if (f.signingKey === null) return { ok: false, reason: "no_signing_key" };
  if (f.repo === null) return { ok: false, reason: "no_repo" };
  if (f.requested.length === 0) return { ok: false, reason: "no_artifacts" };
  const missing = f.requested.filter((n) => !f.recorded.includes(n));
  if (missing.length > 0) {
    return { ok: false, reason: "artifact_not_recorded", detail: missing.join(", ") };
  }
  if (!f.approvalOk) return { ok: false, reason: "no_approval" };
  return { ok: true };
}
