// What a checkout is, done in one place and run in a CHILD process (see checkout-child.ts): fetch
// the commit, write the tree and `.git` into a directory, and stream a gzip tarball of it to a
// file. It runs in its own process because it parses hostile input (a pack from the network) and
// does synchronous work (inflate, hashing, writing thousands of files): out of process, a hostile
// repository can stall or exhaust a process that holds nothing else, and the server's event loop
// and memory are untouched.
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarGzDirectoryToFile } from "@longshore/act-runner";
import { createHttpClient, type SafeFetch } from "@longshore/net";
import { DEFAULT_FETCH_LIMITS, fetchCommit, materialize, type FetchLimits } from "./git-fetch";

export interface CheckoutRequest {
  owner: string;
  repo: string;
  sha: string;
  /** The repository URL; default `https://github.com/<owner>/<repo>.git`. No credentials. */
  url?: string;
  /** An empty directory to write the tree and `.git` into; default a new temporary one. */
  dir?: string;
  /** Where to write the gzip tarball. */
  out: string;
  limits?: Partial<FetchLimits>;
  fetch?: SafeFetch;
  /** Hosts besides github.com the URL may name (an operator's allowlist; a test server). */
  allowHosts?: readonly string[];
  /** Called often during the work; it may throw to stop it (the parent is gone, memory is over). */
  checkpoint?: () => void;
}

export interface CheckoutResult {
  dir: string;
  sha: string;
  files: number;
  tarballBytes: number;
}

const PART = /^[A-Za-z0-9_.-]+$/;

/** An owner or repo name: plain characters, and not `.` or `..`. */
export const isRepoPart = (s: string): boolean => PART.test(s) && s !== "." && s !== "..";

/**
 * The URL's host must be github.com, or one the operator allowed. A repository URL comes from
 * configuration, but the fetch it names is made from the control plane: it never goes anywhere
 * that was not chosen on purpose.
 */
export function assertCloneHost(url: string, allowHosts: readonly string[] = []): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the repository URL is not a URL");
  }
  const host = u.hostname.toLowerCase();
  if (host === "github.com") {
    // github.com only over https and its own port: not http, not another port on the same name.
    if (u.protocol !== "https:" || u.port !== "")
      throw new Error("github.com is only fetched over https on its default port");
    return;
  }
  if (!allowHosts.some((h) => h.toLowerCase() === host))
    throw new Error(`the repository host ${host} is not github.com or an allowed host`);
}

export async function performCheckout(r: CheckoutRequest): Promise<CheckoutResult> {
  if (!isRepoPart(r.owner) || !isRepoPart(r.repo))
    throw new Error("the repository is not a plain owner/name");
  if (!/^[0-9a-f]{40}$/i.test(r.sha)) throw new Error("the commit must be a 40 character sha");
  const url = r.url ?? `https://github.com/${r.owner}/${r.repo}.git`;
  assertCloneHost(url, r.allowHosts);
  const limits = { ...DEFAULT_FETCH_LIMITS, ...r.limits };
  const sha = r.sha.toLowerCase();
  const fetched = await fetchCommit({
    url,
    sha,
    fetch: r.fetch ?? createHttpClient({ allowHosts: [...(r.allowHosts ?? [])] }).fetch,
    limits,
    ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
  });
  const dir = r.dir ?? mkdtempSync(join(tmpdir(), "tt-src-"));
  if (r.dir) {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) throw new Error("the checkout directory is not empty");
  }
  // The remote the sandbox sees is the repository's address, never with credentials.
  const remote = r.url ?? `https://github.com/${r.owner}/${r.repo}`;
  const m = materialize(
    dir,
    fetched,
    remote,
    limits,
    r.checkpoint ? { checkpoint: r.checkpoint } : {},
  );
  const tar = await tarGzDirectoryToFile(dir, r.out, {
    maxBytes: limits.maxTarballBytes,
    ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
  });
  return { dir, sha, files: m.files, tarballBytes: tar.bytes };
}
