// Giving a job its artifact access: a grant for its run and attempt, and the two variables the
// artifact actions read. The grant exists only for the life of the attempt (the caller releases
// it in a finally), and is refused for a job whose sandbox has no network path to the service. A
// sandbox with open egress reaches the service itself and gets a full grant. One with no egress
// but the proxy's upload route gets an upload-only grant: it can put its own artifacts and can
// neither list nor download anything.
import type { TrustClass } from "../trust";
import type { ArtifactService } from "./service";
import {
  type AdoptArtifactSpec,
  type AttemptSeeds,
  sameCheck,
  seedCheck,
} from "../scheduler/adopt-credentials";

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
  /**
   * The grant an adopted attempt held (#787): issued again from the same seed and time, so the
   * token the job holds keeps working. Refused (undefined) when the seed no longer matches.
   */
  adopt?: AdoptArtifactSpec;
};

export type JobArtifacts = {
  /** ACTIONS_RESULTS_URL. */
  resultsUrl: string;
  /** ACTIONS_RUNTIME_TOKEN, also the credential in the blob URLs. The runner redacts it. */
  token: string;
  /** How another controller issues this same grant again (#787); absent: it cannot. */
  adopt?: AdoptArtifactSpec;
  release(): void;
};

export type JobArtifactProvider = (req: JobArtifactRequest) => JobArtifacts | undefined;

/**
 * `seeds` (from the master key): grants are derived, so an adopted attempt keeps its token (#787).
 * Without them every grant is random and bound to this process.
 */
export function jobArtifactProvider(
  service: ArtifactService,
  o: { seeds?: AttemptSeeds; now?: () => number } = {},
): JobArtifactProvider {
  return (req) => {
    if (req.local) return undefined;
    const open = req.egress === "open";
    if (!open && req.proxyRoute !== true) return undefined;
    const mode = open ? "full" : "upload";
    const seed = o.seeds?.("artifact", { orgId: req.scope.orgId, attemptId: req.attemptId });
    // Adopting: the same seed (master key), the same mode, or no grant at all.
    if (req.adopt && (!seed || !sameCheck(seed, req.adopt.check) || req.adopt.mode !== mode)) {
      return undefined;
    }
    const issuedAt = req.adopt?.issuedAt ?? (o.now ?? Date.now)();
    let token: string;
    try {
      token = service.grants.issue(
        {
          attemptId: req.attemptId,
          runId: req.runId,
          scope: req.scope,
          klass: req.klass,
          mode,
        },
        seed ? { seed, issuedAt } : undefined,
      );
    } catch (e) {
      // An adopted grant past its lifetime: none.
      if (req.adopt) return undefined;
      throw e;
    }
    return {
      resultsUrl: service.resultsUrl,
      token,
      ...(seed ? { adopt: { issuedAt, mode, check: seedCheck(seed) } } : {}),
      release: () => service.grants.revoke(req.attemptId),
    };
  };
}
