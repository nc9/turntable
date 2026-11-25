// Who may see which credential when the worker resolves and verifies actions.
//
// A workflow names its own actions, so a credential handed to the resolver is a confused deputy:
// `uses: someorg/private-thing@v1` resolved with a token that can read it would prove the private
// repo exists, reveal its shas, and (if its tarball were fetched with the token) deliver private
// code into a sandbox that can print it. So the token is used only for
//   (a) the run's own repository, and
//   (b) actions whose owner is on the org's action-owner allowlist (an admin vouched for them),
// and never for an untrusted run. Every other action is resolved without a token: a 404 on a
// private repo then correctly means "not found". Even with a token, a repo that is not the run's
// own is refused when GitHub says it is private.
import { PlanError, type ActionRefResolver } from "@turntable/act-runner";
import {
  type Backoff,
  fetchWithBackoff,
  RateLimitedError,
  type SafeFetch,
  safeFetch,
} from "@turntable/net";
import { InfraError } from "@turntable/provider-sdk";
import type { ReachabilityChecker } from "./reachability";

export interface ActionCredentialOptions {
  /** The credential for this run (see forge-token), or undefined. */
  token: string | undefined;
  /** `owner/name` of the run's own repository; null for a run with none. */
  ownRepo: string | null | undefined;
  /** The org's allowed action owners (lowercase); null means no allowlist. */
  allowedOwners: readonly string[] | null;
  /** An untrusted run never uses a token, not even for its own repository. */
  untrusted: boolean;
  /**
   * A local run (`turntable run`, the operator's own checkout and own token): the token is used
   * for any action that passes the public check below, since the operator chose to run this
   * workflow. A server run keeps the strict per-action rule.
   */
  local?: boolean;
  /**
   * The token is an App installation token: like `local`, it is sent for any action repo that
   * passes the public check, since the check fails closed on a private or missing repo. Still
   * never for an untrusted run.
   */
  publicActions?: boolean;
  /**
   * Remembers, across runs and restarts, that a repo was found public, so a second run does not
   * ask again. Only a pass is stored. A failure or a refusal never is.
   */
  publicCache?: {
    get(repo: string): Promise<boolean>;
    put(repo: string): Promise<void>;
  };
  backoff: Backoff;
  fetch?: SafeFetch;
  apiBase?: string;
}

export interface ActionCredentials {
  /** The token this action may be resolved with, or undefined for an anonymous request. */
  tokenFor(owner: string, repo: string): string | undefined;
  isOwn(owner: string, repo: string): boolean;
  /** Throws a policy failure when a token-backed request would reach a private repo that is not the run's own. */
  assertPublic(owner: string, repo: string): Promise<void>;
}

const notAvailable = (key: string): string => `action not available: ${key}`;

export function actionCredentials(o: ActionCredentialOptions): ActionCredentials {
  const own = o.ownRepo?.toLowerCase() ?? null;
  const f = o.fetch ?? safeFetch;
  const base = o.apiBase ?? "https://api.github.com";
  const checked = new Map<string, Promise<void>>();
  const isOwn = (owner: string, repo: string): boolean =>
    own !== null && `${owner}/${repo}`.toLowerCase() === own;
  const tokenFor = (owner: string, repo: string): string | undefined => {
    if (!o.token || o.untrusted) return undefined;
    if (isOwn(owner, repo) || o.local === true || o.publicActions === true) return o.token;
    return o.allowedOwners?.includes(owner.toLowerCase()) ? o.token : undefined;
  };
  const assertPublic = (owner: string, repo: string): Promise<void> => {
    const token = tokenFor(owner, repo);
    if (!token || isOwn(owner, repo)) return Promise.resolve();
    const key = `${owner}/${repo}`.toLowerCase();
    let p = checked.get(key);
    if (!p) {
      p = (async () => {
        if (await o.publicCache?.get(key)) return;
        let res: Response;
        try {
          res = await fetchWithBackoff(
            f,
            `${base}/repos/${owner}/${repo}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                "user-agent": "turntable",
                authorization: `Bearer ${token}`,
              },
              timeoutMs: 30_000,
              maxBytes: 1_048_576,
            },
            o.backoff,
          );
        } catch (e) {
          // Cannot tell whether it is private: do not proceed with a token.
          const why = e instanceof RateLimitedError ? e.message : "cannot reach GitHub";
          throw new InfraError(`checking whether ${key} is public: ${why}`, e);
        }
        // Fail closed: proceed only on a 200 that says `private: false` in so many words.
        // A private repo and one that does not exist answer with the SAME words, so a workflow
        // cannot use this check to learn which private repositories exist.
        if (res.status === 404) throw new PlanError("action-unavailable", notAvailable(key));
        if (!res.ok) {
          // 401, 403, 5xx and the rest: GitHub's state, not an answer. Retryable, never a pass.
          throw new InfraError(`checking whether ${key} is public: HTTP ${res.status}`);
        }
        let info: { private?: unknown };
        try {
          info = (await res.json()) as { private?: unknown };
        } catch (e) {
          throw new InfraError(`checking whether ${key} is public: unreadable response`, e);
        }
        if (info.private === true) {
          throw new PlanError("action-unavailable", notAvailable(key));
        }
        if (info.private !== false) {
          throw new InfraError(`checking whether ${key} is public: no visibility in the response`);
        }
        await o.publicCache?.put(key).catch(() => undefined);
      })();
      checked.set(key, p);
      // Recorded only when the check passed: a refusal or a failure is asked again next time.
      p.catch(() => checked.delete(key));
    }
    return p;
  };
  return { tokenFor, isOwn, assertPublic };
}

/** A resolver that picks the credential per action; `make` builds one for a token (or none). */
export function credentialedResolver(
  c: ActionCredentials,
  make: (token: string | undefined) => ActionRefResolver,
): ActionRefResolver {
  const anon = make(undefined);
  const byToken = new Map<string, ActionRefResolver>();
  return async (owner, repo, ref) => {
    const token = c.tokenFor(owner, repo);
    if (token === undefined) return anon(owner, repo, ref);
    await c.assertPublic(owner, repo);
    let r = byToken.get(token);
    if (!r) byToken.set(token, (r = make(token)));
    return r(owner, repo, ref);
  };
}

/** A reachability checker that picks the credential per action (see credentialedResolver). */
export function credentialedReachability(
  c: ActionCredentials,
  make: (token: string | undefined) => ReachabilityChecker,
): ReachabilityChecker {
  const anon = make(undefined);
  const byToken = new Map<string, ReachabilityChecker>();
  return async (owner, repo, sha) => {
    const token = c.tokenFor(owner, repo);
    if (token === undefined) return anon(owner, repo, sha);
    await c.assertPublic(owner, repo);
    let r = byToken.get(token);
    if (!r) byToken.set(token, (r = make(token)));
    return r(owner, repo, sha);
  };
}
