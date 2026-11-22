// The `github.event` payload act is given (`--eventpath`), so in-sandbox expressions such as
// `github.event.pull_request.base.sha` render as they do on GitHub.
//
// Built only from forge facts that were fetched and stored at ingest (the run row and the event
// stored in the run's plan), copied field by field from an allowlist. Nothing else is ever
// included: no token, no title or body text, nothing a job or an author could smuggle in.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const SHA = /^[0-9a-f]{40}$/;

export interface ActEventRun {
  event: string;
  ref: string;
  sha: string | null;
  repo: string | null;
  prNumber: number | null;
  headBranch: string | null;
  /** The run's stored plan (JSON text), whose `github.event` ingest filled in. */
  plan: string | null;
}

/** The stored `github.event` of a run, or {} when there is none. */
function storedEvent(plan: string | null): Obj {
  if (!plan) return {};
  try {
    const gh = (JSON.parse(plan) as { github?: unknown }).github;
    const ev = isObj(gh) ? gh.event : undefined;
    return isObj(ev) ? ev : {};
  } catch {
    return {};
  }
}

/** Never throws: a payload with fewer fields is better than a job that does not start. */
export function buildActEvent(run: ActEventRun): Record<string, unknown> {
  const stored = storedEvent(run.plan);
  const repository = run.repo ? { repository: { full_name: run.repo } } : {};
  if (run.event === "pull_request" || run.event === "pull_request_target") {
    const pr = isObj(stored.pull_request) ? stored.pull_request : {};
    const base = isObj(pr.base) ? pr.base : {};
    const head = isObj(pr.head) ? pr.head : {};
    const number = run.prNumber ?? (typeof pr.number === "number" ? pr.number : undefined);
    const baseSha = str(base.sha);
    const headSha = run.sha ?? str(head.sha);
    const action = str(stored.action);
    return {
      ...(action ? { action } : {}),
      ...(number === undefined ? {} : { number }),
      pull_request: {
        ...(number === undefined ? {} : { number }),
        base: {
          ref: str(base.ref) ?? "",
          ...(baseSha && SHA.test(baseSha) ? { sha: baseSha } : {}),
          ...(run.repo ? { repo: { full_name: run.repo } } : {}),
        },
        head: {
          ref: run.headBranch ?? str(head.ref) ?? "",
          ...(headSha ? { sha: headSha } : {}),
          ...(run.repo ? { repo: { full_name: run.repo } } : {}),
        },
        draft: pr.draft === true,
      },
      ...repository,
    };
  }
  if (run.event === "push") {
    const before = str(stored.before);
    return {
      ref: run.ref,
      ...(before && SHA.test(before) ? { before } : {}),
      ...(run.sha ? { after: run.sha } : {}),
      ...repository,
    };
  }
  return { ...repository };
}
