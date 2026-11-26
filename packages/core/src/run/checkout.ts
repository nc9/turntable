// What a checkout is, done in one place and run in a CHILD process (see checkout-child.ts): fetch
// the commit, write the tree and `.git` into a directory, and stream a gzip tarball of it to a
// file. It runs in its own process because it parses hostile input (a pack from the network) and
// does synchronous work (inflate, hashing, writing thousands of files): out of process, a hostile
// repository can stall or exhaust a process that holds nothing else, and the server's event loop
// and memory are untouched.
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tarGzDirectoryToFile } from "@turntable/act-runner";
import { createHttpClient, type SafeFetch } from "@turntable/net";
import {
  DEFAULT_FETCH_LIMITS,
  fetchCommit,
  GitFetchError,
  materialize,
  type FetchLimits,
} from "./git-fetch";
import { resolveSubmodules, writeManifest, type Gitlink } from "./submodules";

export interface CheckoutRequest {
  owner: string;
  repo: string;
  sha: string;
  /** The repository URL; default `https://github.com/<owner>/<repo>.git`. No credentials. */
  url?: string;
  /** An empty directory to write the tree and `.git` into; default a new temporary one. */
  dir?: string;
  /** Where to write the gzip tarball. Absent: the tree is written and no tarball made. */
  out?: string;
  limits?: Partial<FetchLimits>;
  fetch?: SafeFetch;
  /** Hosts besides github.com the URL may name (an operator's allowlist; a test server). */
  allowHosts?: readonly string[];
  /** Called often during the work; it may throw to stop it (the parent is gone, memory is over). */
  checkpoint?: () => void;
  /** A repo-scoped installation token (private repositories). Never written anywhere. */
  token?: string;
  /** Deliver the whole history, the tags and the default branch (see FetchOptions.fullHistory). */
  fullHistory?: boolean;
  /**
   * Write the submodules this tree names (its gitlinks paired with `.gitmodules`, every entry
   * checked) to this file. The caller fetches them, each with its own credential.
   */
  manifest?: string;
  /**
   * This checkout IS a submodule: once its tree has been written and scanned (a scratch `dir`),
   * its `.git` is moved to this path, as the module's git directory under the parent's
   * `.git/modules`, and the tree is left to be thrown away.
   */
  moduleGitDir?: string;
}

export interface CheckoutResult {
  dir: string;
  sha: string;
  files: number;
  tarballBytes: number;
  /** What this checkout spent of the limits, for a caller that shares them with more fetches. */
  usage: { files: number; packBytes: number; inflatedBytes: number; objects: number };
}

/** The `.gitmodules` at the root of a written tree: a regular file, bounded. */
function readGitmodules(dir: string): string | undefined {
  const p = join(dir, ".gitmodules");
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile() || st.size > 1024 * 1024)
    throw new GitFetchError(".gitmodules is not a plain file of a sane size");
  return readFileSync(p, "utf8");
}

/** Moves a scratch checkout's `.git` to where the parent keeps the module's git directory. */
function installModuleGitDir(scratch: string, target: string): void {
  if (lstatSync(target, { throwIfNoEntry: false }))
    throw new GitFetchError("the module's git directory already exists");
  mkdirSync(dirname(target), { recursive: true });
  const from = join(scratch, ".git");
  // A module's git directory has no index of its own until it is checked out.
  rmSync(join(from, "index"), { force: true });
  try {
    renameSync(from, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, target, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Packs an already written tree (the main checkout, with its modules) into the tarball. */
export async function packCheckout(r: {
  dir: string;
  out: string;
  limits?: Partial<FetchLimits>;
  checkpoint?: () => void;
}): Promise<{ tarballBytes: number }> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...r.limits };
  const tar = await tarGzDirectoryToFile(r.dir, r.out, {
    maxBytes: limits.maxTarballBytes,
    ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
  });
  return { tarballBytes: tar.bytes };
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
    ...(r.token ? { token: r.token } : {}),
    ...(r.fullHistory ? { fullHistory: true } : {}),
  });
  const dir = r.dir ?? mkdtempSync(join(tmpdir(), "tt-src-"));
  if (r.dir) {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length > 0) throw new Error("the checkout directory is not empty");
  }
  // The remote the sandbox sees is the repository's address, never with credentials.
  const remote = r.url ?? `https://github.com/${r.owner}/${r.repo}`;
  const usage = { ...fetched.usage, files: 0 };
  const gitlinks: Gitlink[] = [];
  const m = materialize(dir, fetched, remote, limits, {
    ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
    ...(r.manifest ? { gitlinks } : {}),
  });
  usage.files = m.files;
  if (r.manifest) {
    writeManifest(
      r.manifest,
      resolveSubmodules({
        gitmodules: gitlinks.length > 0 ? readGitmodules(dir) : undefined,
        gitlinks,
        baseUrl: `https://github.com/${r.owner}/${r.repo}`,
        maxSubmodules: limits.maxSubmodules,
      }),
    );
  }
  if (r.moduleGitDir) installModuleGitDir(dir, r.moduleGitDir);
  const tarballBytes = r.out
    ? (
        await packCheckout({
          dir,
          out: r.out,
          limits,
          ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
        })
      ).tarballBytes
    : 0;
  return { dir, sha, files: m.files, tarballBytes, usage };
}
