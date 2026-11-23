// Giving a job its artifact access: a grant for its run and attempt, and the two variables the
// artifact actions read. The grant exists only for the life of the attempt (the caller releases
// it in a finally), and is refused for a job whose sandbox has no network path to the service.
import type { TrustClass } from "../trust";
import type { ArtifactService } from "./service";

export type JobArtifactRequest = {
  runId: string;
  attemptId: string;
  scope: { orgId: string; projectId: string };
  klass: TrustClass;
  /** The sandbox's egress: only `open` can reach the service. */
  egress: "none" | "open";
  /** A local run (`turntable run`) has no control plane to talk to. */
  local: boolean;
};

export type JobArtifacts = {
  /** ACTIONS_RESULTS_URL. */
  resultsUrl: string;
  /** ACTIONS_RUNTIME_TOKEN, also the credential in the blob URLs. The runner redacts it. */
  token: string;
  release(): void;
};

export type JobArtifactProvider = (req: JobArtifactRequest) => JobArtifacts | undefined;

export function jobArtifactProvider(service: ArtifactService): JobArtifactProvider {
  return (req) => {
    if (req.egress !== "open" || req.local) return undefined;
    const token = service.grants.issue({
      attemptId: req.attemptId,
      runId: req.runId,
      scope: req.scope,
      klass: req.klass,
    });
    return {
      resultsUrl: service.resultsUrl,
      token,
      release: () => service.grants.revoke(req.attemptId),
    };
  };
}
