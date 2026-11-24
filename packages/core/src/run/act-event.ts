// The `github.event` payload act is given (`--eventpath`), so in-sandbox expressions such as
// `github.event.pull_request.base.sha` render as they do on GitHub.
//
// Built only from forge facts that were fetched and stored at ingest (the run row and the event
// stored in the run's plan), copied field by field from an allowlist. Nothing else is ever
// included: no token, nothing a job could smuggle in.
//
// PR text (title, body, labels) is attacker-controlled. It enters ONLY this event JSON, exactly as
// on GitHub, where using `${{ github.event.pull_request.title }}` inside a `run:` step is the
// workflow author's own injection risk. That is safe here because of the core invariant: a job for
// an untrusted author holds no usable credentials (trust classes, #17), so an injection gains
// nothing beyond what the author's own code could already do. Turntable itself never renders,
// returns or summarises PR text: no operation result, event, log line, check-run summary or
// command line carries it (pr-text-not-exposed.test.ts holds that line).
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
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

/** `{login, type}` from a stored user object, or undefined. */
function user(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined;
  const login = str(v.login);
  if (!login) return undefined;
  const type = str(v.type);
  return { login, ...(type ? { type } : {}) };
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
    const headRepoStored = isObj(head.repo) ? head.repo : {};
    const headRepoName = str(headRepoStored.full_name) ?? run.repo ?? undefined;
    const fork = bool(headRepoStored.fork);
    const author = user(pr.user);
    const sender = user(stored.sender);
    const labels = Array.isArray(pr.labels)
      ? pr.labels.flatMap((l) => (isObj(l) && typeof l.name === "string" ? [{ name: l.name }] : []))
      : undefined;
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
          ...(headRepoName
            ? { repo: { full_name: headRepoName, ...(fork === undefined ? {} : { fork }) } }
            : {}),
        },
        draft: pr.draft === true,
        ...(typeof pr.title === "string" ? { title: pr.title } : {}),
        ...(typeof pr.body === "string" ? { body: pr.body } : {}),
        ...(labels ? { labels } : {}),
        ...(author ? { user: author } : {}),
      },
      ...(sender ? { sender } : {}),
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
