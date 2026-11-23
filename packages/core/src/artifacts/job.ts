// Giving a job its artifact access: a grant for its run and attempt, and the two variables the
// artifact actions read. The grant exists only for the life of the attempt (the caller releases
// it in a finally), and is refused for a job whose sandbox has no network path to the service. A
// sandbox with open egress reaches the service itself and gets a full grant. One with no egress
// but the proxy's upload route gets an upload-only grant: it can put its own artifacts and can
// neither list nor download anything.
import type { TrustClass } from "../trust";
import type { ArtifactService } from "./service";

export type JobArtifactRequest = {
  runId: string;
  attemptId: string;
  scope: { orgId: string; projectId: string };
  klass: TrustClass;
  /** The sandbox's egress: `open` reaches the service itself. */
  egress: "none" | "open";
  /**
   * The sandbox has no network of its own but the proxy lets it through to the service's upload
   * endpoints (proxy/index.ts, artifactRules). It then gets an upload-only credential.
   */
  proxyRoute?: boolean;
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
    if (req.local) return undefined;
    const open = req.egress === "open";
    if (!open && req.proxyRoute !== true) return undefined;
    const token = service.grants.issue({
      attemptId: req.attemptId,
      runId: req.runId,
      scope: req.scope,
      klass: req.klass,
      mode: open ? "full" : "upload",
    });
    return {
      resultsUrl: service.resultsUrl,
      token,
      release: () => service.grants.revoke(req.attemptId),
    };
  };
}
