// A GitHub API stand-in served through fetch, for the poller and the worker-path tests.
export const SHA = (c: string): string => c.repeat(40);

export type StubPull = {
  number: number;
  user: string;
  headSha: string;
  baseRef?: string;
  headRef?: string;
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
          head: { sha: p.headSha, ref: p.headRef ?? "topic", repo: { full_name: repo } },
          base: { ref: p.baseRef ?? "main", repo: { full_name: repo } },
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
