// The two writes a label approval makes to a pull request, through the GitHub App (`issues:
// write`): remove the label a new push made stale, and say once that a new label is needed. Both
// are best-effort: the timestamp rule in `label-approval.ts` is what enforces the approval, so a
// failure here never lets a run through. The poll client itself only ever sends GET.
import { safeFetch } from "@turntable/net";
import type { FetchLike } from "./github";

export interface PrNoticeWriter {
  /** Removes a label from a pull request. A label that is not there is not an error. */
  removeLabel(repo: string, pr: number, label: string): Promise<void>;
  /** Adds one comment to a pull request. */
  comment(repo: string, pr: number, body: string): Promise<void>;
}

const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** A writer that sends with one installation token; the token never goes into a URL or a log. */
export function githubNoticeWriter(o: {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}): PrNoticeWriter {
  const base = o.baseUrl.replace(/\/$/, "");
  const send = o.fetch ?? ((url, init) => safeFetch(url, init));
  const call = async (method: string, path: string, body?: unknown): Promise<number> => {
    const res = await send(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "turntable-poller",
        authorization: `Bearer ${o.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.status;
  };
  return {
    async removeLabel(repo, pr, label) {
      if (!REPO.test(repo)) throw new Error("bad repo");
      const status = await call(
        "DELETE",
        `/repos/${repo}/issues/${pr}/labels/${encodeURIComponent(label)}`,
      );
      if (status !== 404 && (status < 200 || status >= 300)) {
        throw new Error(`removing the label failed: HTTP ${status}`);
      }
    },
    async comment(repo, pr, body) {
      if (!REPO.test(repo)) throw new Error("bad repo");
      const status = await call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
      if (status < 200 || status >= 300) throw new Error(`commenting failed: HTTP ${status}`);
    },
  };
}
