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
    /** What GitHub says the default branch is (for ingest drift). */
    defaultBranch: "main",
    /** Merge queue branches (`gh-readonly-queue/main/...`) and what GitHub says about each commit. */
    queue: [] as {
      ref: string;
      sha: string;
      verified?: boolean;
      committerEmail?: string;
      message?: string;
    }[],
    /** Tags by name: the commit, or (annotated) the tag object that points at it. */
    tags: new Map<string, { sha: string; annotatedAs?: string; tagger?: string }>(),
    /** The default branch's commits, newest first, as the commit listing reports them. */
    history: [] as { sha: string; parents: string[] }[],
    /** Tag rulesets, as the rulesets API would report them. */
    rulesets: [] as {
      id: number;
      target?: string;
      enforcement?: string;
      include: string[];
      exclude?: string[];
      rules?: string[];
      bypass?: { actor_type: string; actor_id: number | null }[];
      /** Leave `bypass_actors` out of the detail, as the API does without admin read access. */
      omitBypass?: boolean;
      /** ISO time the ruleset was last changed, if the API says. */
      updatedAt?: string;
    }[],
    /** Answer the rulesets endpoints with this status instead (403: the token cannot read them). */
    rulesetsStatus: undefined as number | undefined,
    /** Author login (null: no linked account) and message of a commit, by sha. */
    commits: new Map<string, { login: string | null; message: string }>(),
    calls: [] as { path: string; method: string | undefined; ifNoneMatch?: string }[],
  };
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const inm = new Headers(init?.headers).get("if-none-match") ?? undefined;
    state.calls.push({
      path: path + u.search,
      method: init?.method,
      ...(inm ? { ifNoneMatch: inm } : {}),
    });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path === `/repos/${repo}`) return json({ default_branch: state.defaultBranch });
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
    const tagList = new RegExp(`^/repos/${repo}/git/matching-refs/tags/(.*)$`).exec(path);
    if (tagList) {
      const body = [...state.tags]
        .filter(([name]) => name.startsWith(tagList[1] as string))
        .map(([name, v]) => ({
          ref: `refs/tags/${name}`,
          object: v.annotatedAs
            ? { type: "tag", sha: v.annotatedAs }
            : { type: "commit", sha: v.sha },
        }));
      const text = JSON.stringify(body);
      const etag = `"tags-${new Bun.CryptoHasher("sha1").update(text).digest("hex")}"`;
      if (inm === etag) return new Response(null, { status: 304 });
      return new Response(text, { headers: { "content-type": "application/json", etag } });
    }
    const tagObj = new RegExp(`^/repos/${repo}/git/tags/([0-9a-f]{40})$`).exec(path);
    if (tagObj) {
      const hit = [...state.tags.values()].find((v) => v.annotatedAs === tagObj[1]);
      return hit
        ? json({
            tagger: hit.tagger === undefined ? null : { name: hit.tagger },
            object: { type: "commit", sha: hit.sha },
          })
        : new Response("not found", { status: 404 });
    }
    if (path === `/repos/${repo}/commits` && u.searchParams.has("sha")) {
      const page = Number(u.searchParams.get("page") ?? "1");
      const per = Number(u.searchParams.get("per_page") ?? "30");
      return json(
        state.history.slice((page - 1) * per, page * per).map((c) => ({
          sha: c.sha,
          parents: c.parents.map((sha) => ({ sha })),
        })),
      );
    }
    if (path === `/repos/${repo}/rulesets`) {
      if (state.rulesetsStatus) return new Response("no", { status: state.rulesetsStatus });
      return json(
        state.rulesets.map((r) => ({
          id: r.id,
          target: r.target ?? "tag",
          enforcement: r.enforcement ?? "active",
        })),
      );
    }
    const rs = new RegExp(`^/repos/${repo}/rulesets/(\\d+)$`).exec(path);
    if (rs) {
      if (state.rulesetsStatus) return new Response("no", { status: state.rulesetsStatus });
      const r = state.rulesets.find((x) => x.id === Number(rs[1]));
      return r
        ? json({
            id: r.id,
            target: r.target ?? "tag",
            enforcement: r.enforcement ?? "active",
            conditions: { ref_name: { include: r.include, exclude: r.exclude ?? [] } },
            rules: (r.rules ?? ["creation", "update", "deletion", "non_fast_forward"]).map(
              (type) => ({
                type,
              }),
            ),
            ...(r.omitBypass ? {} : { bypass_actors: r.bypass ?? [] }),
            ...(r.updatedAt ? { updated_at: r.updatedAt } : {}),
          })
        : new Response("not found", { status: 404 });
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
    const known = commit ? state.commits.get(commit[1] as string) : undefined;
    if (commit && known) {
      return json({
        sha: commit[1],
        commit: { message: known.message },
        author: known.login === null ? null : { login: known.login },
      });
    }
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
