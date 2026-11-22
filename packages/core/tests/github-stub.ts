// A GitHub API stand-in served through fetch, for the poller and the worker-path tests.
export const SHA = (c: string): string => c.repeat(40);

export type StubPull = {
  number: number;
  user: string;
  headSha: string;
  baseRef?: string;
  /** The base branch commit. Default: 40 `b`s. */
  baseSha?: string;
  headRef?: string;
  /** `owner/name` of the head repo; null is a deleted fork. Default: the base repo. */
  headRepo?: string | null;
};

export function makeGithub(repo = "acme/web", workflowPath = ".github/workflows/ci.yml") {
  const state = {
    head: { sha: SHA("a"), message: "feat: first", login: "octocat" },
    pulls: [] as StubPull[],
    /** Workflow text by commit sha; "*" is the fallback. */
    files: new Map<string, string>(),
    /** Changed files by `base...head`. A missing entry answers 404. */
    compare: new Map<string, string[]>(),
    /** Other repo files by path (local composite actions), served for any sha. */
    extra: new Map<string, string>(),
    /** Collaborator role_name by login; a login not listed is not a user (404). */
    roles: new Map<string, string>(),
    /** Answer the permission endpoint with this status instead (403: token cannot ask; 500). */
    permissionStatus: undefined as number | undefined,
    protectedMain: true,
    /** Merge queue branches (`gh-readonly-queue/main/...`) and what GitHub says about each commit. */
    queue: [] as {
      ref: string;
      sha: string;
      verified?: boolean;
      committerEmail?: string;
      message?: string;
    }[],
    calls: [] as { path: string; method: string | undefined }[],
  };
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    state.calls.push({ path: path + u.search, method: init?.method });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path === `/repos/${repo}/commits/main`) {
      return json({
        sha: state.head.sha,
        commit: { message: state.head.message },
        author: { login: state.head.login },
      });
    }
    if (path === `/repos/${repo}/branches/main`) return json({ protected: state.protectedMain });
    const perm = new RegExp(`^/repos/${repo}/collaborators/([^/]+)/permission$`).exec(path);
    if (perm) {
      if (state.permissionStatus) return new Response("no", { status: state.permissionStatus });
      const role = state.roles.get(perm[1] as string);
      if (role === undefined) return new Response("not found", { status: 404 });
      const legacy =
        role === "admin"
          ? "admin"
          : role === "write" || role === "maintain"
            ? "write"
            : role === "none"
              ? "none"
              : "read";
      return json({ permission: legacy, role_name: role });
    }
    if (path === `/repos/${repo}/git/matching-refs/heads/gh-readonly-queue/main/`) {
      return json(state.queue.map((q) => ({ ref: q.ref, object: { sha: q.sha } })));
    }
    const queued = new RegExp(`^/repos/${repo}/commits/([0-9a-f]{40})$`).exec(path);
    const qc = queued ? state.queue.find((q) => q.sha === queued[1]) : undefined;
    if (qc) {
      return json({
        sha: qc.sha,
        parents: [{ sha: SHA("b") }],
        commit: {
          message: qc.message ?? "Merge pull request from gh-readonly-queue",
          committer: { email: qc.committerEmail ?? "noreply@github.com" },
          verification: { verified: qc.verified ?? true, reason: "valid" },
        },
      });
    }
    const commit = new RegExp(`^/repos/${repo}/commits/([0-9a-f]{40})$`).exec(path);
    if (commit) {
      const pull = state.pulls.find((p) => p.headSha === commit[1]);
      return json({
        sha: commit[1],
        commit: { message: `head commit of #${pull?.number}` },
        author: pull ? { login: pull.user } : null,
      });
    }
    if (path === `/repos/${repo}/pulls`) {
      return json(
        state.pulls.map((p) => ({
          number: p.number,
          title: `PR ${p.number}`,
          user: { login: p.user },
          head: {
            sha: p.headSha,
            ref: p.headRef ?? "topic",
            repo: p.headRepo === null ? null : { full_name: p.headRepo ?? repo },
          },
          base: { ref: p.baseRef ?? "main", sha: p.baseSha ?? SHA("b"), repo: { full_name: repo } },
        })),
      );
    }
    const cmp = new RegExp(`^/repos/${repo}/compare/(.+)$`).exec(path);
    if (cmp) {
      const files = state.compare.get(cmp[1] as string);
      return files === undefined
        ? new Response("not found", { status: 404 })
        : json({ files: files.map((filename) => ({ filename })) });
    }
    const content = new RegExp(`^/repos/${repo}/contents/(.+)$`).exec(path);
    if (content && content[1] !== workflowPath) {
      const text = state.extra.get(content[1] as string);
      return text === undefined ? new Response("not found", { status: 404 }) : new Response(text);
    }
    if (path === `/repos/${repo}/contents/${workflowPath}`) {
      const sha = u.searchParams.get("ref") ?? "";
      const text = state.files.get(sha) ?? state.files.get("*");
      return text === undefined ? new Response("not found", { status: 404 }) : new Response(text);
    }
    return new Response("unexpected", { status: 500 });
  };
  return { state, fetch: fetchStub };
}
