// SLSA v1 provenance, written by the control plane. The job cannot influence it: every field comes
// from what the server stored (the run, its plan, the artifact store), and the signature is made
// by a key the job never touches.
import type { Artifact } from "./types";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const LONGSHORE_BUILD_TYPE = "https://longshore.dev/buildtype/workflow/v1";

export interface ResolvedAction {
  /** `uses:` as written, for example `actions/checkout@v4`. */
  uses: string;
  /** `owner/repo`. */
  repo: string;
  ref: string;
  /** The commit it was pinned to. */
  sha: string;
}

export interface ProvenanceInput {
  /** The Longshore instance, a URL. */
  builderId: string;
  /** Run id. */
  invocationId: string;
  /** `owner/repo`, for the source URI. */
  repo: string;
  workflowPath: string;
  ref: string;
  sha: string;
  event: string;
  inputs: Readonly<Record<string, string>>;
  actions: readonly ResolvedAction[];
  /** The artifacts being attested: statement subjects. */
  subjects: readonly Artifact[];
  /** Other artifacts of the run that were recorded: kept as byproducts. */
  byproducts: readonly Artifact[];
  startedOn?: string | undefined;
  finishedOn?: string | undefined;
}

export interface Statement {
  _type: typeof STATEMENT_TYPE;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: typeof PREDICATE_TYPE;
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: Record<string, unknown>;
      resolvedDependencies: {
        uri: string;
        name: string;
        digest: { gitCommit: string };
        annotations?: { ref: string };
      }[];
    };
    runDetails: {
      builder: { id: string };
      metadata: { invocationId: string; startedOn?: string; finishedOn?: string };
      byproducts: { name: string; digest: { sha256: string } }[];
    };
  };
}

export function buildStatement(i: ProvenanceInput): Statement {
  // One entry per distinct commit of an action, in a stable order.
  const seen = new Set<string>();
  const actions = i.actions
    .filter((a) => {
      const key = `${a.repo}@${a.sha}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .toSorted((a, b) => `${a.repo}@${a.sha}`.localeCompare(`${b.repo}@${b.sha}`));
  return {
    _type: STATEMENT_TYPE,
    subject: i.subjects.map((s) => ({ name: s.name, digest: { sha256: s.sha256 } })),
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: LONGSHORE_BUILD_TYPE,
        externalParameters: {
          workflow: i.workflowPath,
          ref: i.ref,
          sha: i.sha,
          event: i.event,
          inputs: { ...i.inputs },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${i.repo}@${i.ref}`,
            name: "source",
            digest: { gitCommit: i.sha },
          },
          ...actions.map((a) => ({
            uri: `git+https://github.com/${a.repo}`,
            name: a.uses,
            digest: { gitCommit: a.sha },
            annotations: { ref: a.ref },
          })),
        ],
      },
      runDetails: {
        builder: { id: i.builderId },
        metadata: {
          invocationId: i.invocationId,
          ...(i.startedOn ? { startedOn: i.startedOn } : {}),
          ...(i.finishedOn ? { finishedOn: i.finishedOn } : {}),
        },
        byproducts: i.byproducts.map((b) => ({ name: b.name, digest: { sha256: b.sha256 } })),
      },
    },
  };
}

/** The bytes that are signed: the statement as JSON. */
export const statementBytes = (s: Statement): Buffer => Buffer.from(JSON.stringify(s));
