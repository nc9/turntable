// What the release lane asks the forge itself, with its own credential, before it acts: which
// commit does this tag point at. It never takes the answer from the main process's rows.
import { safeFetch, type SafeFetch } from "@turntable/net";

export type TagFacts = { found: false } | { found: true; sha: string };

export interface ForgeFacts {
  /** The commit `tag` resolves to in `repo` (owner/name), annotated tags followed to the commit. */
  tagCommit(repo: string, tag: string): Promise<TagFacts>;
}

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** GitHub, through the guarded outbound client, with the lane's own token. */
export function githubForge(opts: {
  token: string;
  fetch?: SafeFetch;
  apiBase?: string;
}): ForgeFacts {
  const f = opts.fetch ?? safeFetch;
  const base = opts.apiBase ?? "https://api.github.com";
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await f(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      timeoutMs: 15_000,
      maxBytes: 1024 * 1024,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
  return {
    async tagCommit(repo, tag) {
      if (!REPO.test(repo)) throw new Error("repository is not owner/name");
      const ref = await get(
        `/repos/${repo}/git/ref/tags/${tag.split("/").map(encodeURIComponent).join("/")}`,
      );
      if (ref.status === 404) return { found: false };
      if (ref.status !== 200) throw new Error(`forge answered ${ref.status} for the tag`);
      let obj = (ref.body as { object?: { type?: string; sha?: string } }).object;
      // An annotated tag points at a tag object: follow it (a few levels at most) to the commit.
      for (let i = 0; obj?.type === "tag" && i < 3; i += 1) {
        const t = await get(`/repos/${repo}/git/tags/${obj.sha}`);
        if (t.status !== 200) throw new Error(`forge answered ${t.status} for the tag object`);
        obj = (t.body as { object?: { type?: string; sha?: string } }).object;
      }
      if (obj?.type !== "commit" || !/^[0-9a-f]{40}$/.test(obj.sha ?? "")) {
        throw new Error("the tag does not resolve to a commit");
      }
      return { found: true, sha: obj.sha as string };
    },
  };
}
