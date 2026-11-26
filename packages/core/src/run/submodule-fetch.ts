// The parent side of submodules (#685). The checkout child that wrote the main tree listed the
// submodules it names (a manifest, checked again here). Each one is then fetched by a child of its
// own, because each needs its own credential and a child holds exactly one: a same-owner module
// gets an installation token scoped to that one repository (contents read-only, minted here and
// handed over on stdin), every other module is fetched anonymously, and nothing is ever sent with
// a broader credential. All of them draw on the one budget of the checkout: the same limits (what
// is left of them after the main tree and the modules before), the same wall clock, and the same
// scan of what is written. A module that cannot be had fails the whole checkout; nothing is
// delivered half-way.
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckoutConfig,
  CheckoutAuthError,
  CheckoutLimitError,
  type ChildResult,
  runCheckoutChild,
} from "./checkout-child";
import { assertCloneHost } from "./checkout";
import { clean, DEFAULT_FETCH_LIMITS, GitFetchError } from "./git-fetch";
import { scrubToken } from "./scrub-token";
import { moduleGitDir, readManifest, type SubmoduleSpec } from "./submodules";

/** How deep recursive modules may nest. */
const MAX_DEPTH = 8;

export interface SubmoduleDelivery {
  /** `true`: the modules the tree names; `recursive`: and theirs, and so on. */
  mode: "true" | "recursive";
  /** The main tree, already written by the `tree` stage. */
  root: string;
  /** The manifest the `tree` stage wrote. */
  manifest: string;
  /** What the `tree` stage spent. */
  main: ChildResult;
  /** The repository that holds the gitlinks. */
  owner: string;
  installationId?: string | undefined;
  /** A one-repository, contents read-only installation token (see CHECKOUT_PERMISSIONS). */
  mint?: ((installationId: string, repo: string) => Promise<string>) | undefined;
  /** The clone url of a module's repository, when the source is not github.com (test seam). */
  cloneUrl?: ((owner: string, repo: string) => string) | undefined;
  allowHosts: readonly string[];
  config: CheckoutConfig;
  /** When the whole checkout started: the wall clock is shared. */
  startedAt: number;
  signal?: AbortSignal | undefined;
  command?: string[] | undefined;
}

const MIB = 1024 * 1024;

/**
 * Fetches every submodule into `root/.git/modules`, in order, and returns how much of the budget
 * was spent. Throws with a reason that names the module when one cannot be delivered.
 */
export async function deliverSubmodules(o: SubmoduleDelivery): Promise<void> {
  const lim = { ...DEFAULT_FETCH_LIMITS, ...o.config.limits };
  const used = {
    ...(o.main.usage ?? { files: o.main.files, packBytes: 0, inflatedBytes: 0, objects: 0 }),
  };
  const queue: { spec: SubmoduleSpec; chain: string[]; depth: number }[] = readManifest(
    o.manifest,
    { maxSubmodules: lim.maxSubmodules },
  ).map((spec) => ({ spec, chain: [spec.name], depth: 1 }));
  let count = 0;
  while (queue.length > 0) {
    const { spec, chain, depth } = queue.shift() as (typeof queue)[number];
    count += 1;
    if (count > lim.maxSubmodules)
      throw new GitFetchError(`the repository has more than ${lim.maxSubmodules} submodules`);
    if (depth > MAX_DEPTH)
      throw new GitFetchError(`submodules are nested more than ${MAX_DEPTH} deep`);
    const left = {
      files: lim.maxEntries - used.files,
      packBytes: lim.maxPackBytes - used.packBytes,
      inflatedBytes: lim.maxInflatedBytes - used.inflatedBytes,
      objects: lim.maxObjects - used.objects,
      ms: o.config.timeoutMs - (Date.now() - o.startedAt),
    };
    if (left.files <= 0)
      throw new GitFetchError("the repository and its submodules have too many files");
    // The one budget: a size spent up by the repository and its modules is the `fetch_limit` kind,
    // naming the whole limit (not what was left for this module) and the setting that raises it.
    if (left.inflatedBytes <= 0)
      throw new CheckoutLimitError(
        "maxInflatedBytes",
        Math.round(lim.maxInflatedBytes / MIB),
        false,
      );
    if (left.packBytes <= 0)
      throw new CheckoutLimitError("maxPackBytes", Math.round(lim.maxPackBytes / MIB), false);
    if (left.objects <= 0)
      throw new GitFetchError("the repository and its submodules have too many objects");
    if (left.ms <= 1000) throw new GitFetchError("the checkout took too long");
    const label = `submodule ${JSON.stringify(clean(spec.path, 80))} (${spec.owner}/${spec.repo})`;

    // The credential: only a same-owner module, only when the installation can mint one for that
    // one repository. Whatever else, it is fetched anonymously (a public repository needs no more).
    let token: string | undefined;
    let why = "";
    if (spec.owner.toLowerCase() === o.owner.toLowerCase() && o.installationId && o.mint) {
      try {
        token = await o.mint(o.installationId, spec.repo);
      } catch {
        why = " (the installation could not give a read token for it, so it was tried anonymously)";
      }
    }
    const url = o.cloneUrl?.(spec.owner, spec.repo);
    if (url !== undefined) assertCloneHost(url, o.allowHosts);
    const scratch = mkdtempSync(join(tmpdir(), "tt-src-"));
    const nested = join(tmpdir(), `tt-src-${crypto.randomUUID()}.json`);
    try {
      const res = await runCheckoutChild({
        stage: "module",
        owner: spec.owner,
        repo: spec.repo,
        sha: spec.sha,
        ...(url !== undefined ? { url } : {}),
        dir: scratch,
        moduleGitDir: moduleGitDir(o.root, chain),
        ...(o.mode === "recursive" ? { manifest: nested } : {}),
        ...(token ? { token } : {}),
        allowHosts: o.allowHosts,
        config: {
          ...o.config,
          timeoutMs: left.ms,
          limits: {
            ...o.config.limits,
            maxEntries: left.files,
            maxPackBytes: left.packBytes,
            maxInflatedBytes: left.inflatedBytes,
            maxObjects: left.objects,
          },
        },
        signal: o.signal,
        ...(o.command ? { command: o.command } : {}),
      });
      if (res.sha !== spec.sha)
        throw new Error("the module is a different commit than the one pinned");
      if (res.usage) {
        used.files += res.usage.files;
        used.packBytes += res.usage.packBytes;
        used.inflatedBytes += res.usage.inflatedBytes;
        used.objects += res.usage.objects;
      }
      if (o.mode === "recursive")
        for (const child of readManifest(nested, { maxSubmodules: lim.maxSubmodules }))
          queue.push({ spec: child, chain: [...chain, child.name], depth: depth + 1 });
    } catch (e) {
      // The module's child ran over what was left of the shared budget: report the whole budget.
      if (e instanceof CheckoutLimitError && e.limit !== "memory")
        throw new CheckoutLimitError(e.limit, Math.round(lim[e.limit] / MIB), false);
      if (e instanceof CheckoutAuthError)
        throw new CheckoutAuthError(
          e.status,
          token
            ? `${label} was refused by GitHub (HTTP ${e.status}): check that the Turntable CI App installation covers ${spec.owner}/${spec.repo}`
            : `${label} was refused by GitHub (HTTP ${e.status}): it is private or does not exist, and only a same-owner repository the installation covers is read with a credential${why}`,
        );
      const msg = scrubToken(e instanceof Error ? e.message : String(e), token);
      throw new Error(`${label}: ${clean(msg, 300)}${why}`);
    } finally {
      await Promise.all([
        rm(scratch, { recursive: true, force: true }),
        rm(nested, { force: true }),
      ]).catch(() => {});
    }
  }
}
