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
import { PlanError, type ActionRefResolver } from "@longshore/act-runner";
import {
  type Backoff,
  fetchWithBackoff,
  RateLimitedError,
  type SafeFetch,
  safeFetch,
} from "@longshore/net";
import { InfraError } from "@longshore/provider-sdk";
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

export function actionCredentials(o: ActionCredentialOptions): ActionCredentials {
  const own = o.ownRepo?.toLowerCase() ?? null;
  const f = o.fetch ?? safeFetch;
  const base = o.apiBase ?? "https://api.github.com";
  const checked = new Map<string, Promise<void>>();
  const isOwn = (owner: string, repo: string): boolean =>
    own !== null && `${owner}/${repo}`.toLowerCase() === own;
  const tokenFor = (owner: string, repo: string): string | undefined => {
    if (!o.token || o.untrusted) return undefined;
    if (isOwn(owner, repo)) return o.token;
    return o.allowedOwners?.includes(owner.toLowerCase()) ? o.token : undefined;
  };
  const assertPublic = (owner: string, repo: string): Promise<void> => {
    const token = tokenFor(owner, repo);
    if (!token || isOwn(owner, repo)) return Promise.resolve();
    const key = `${owner}/${repo}`.toLowerCase();
    let p = checked.get(key);
    if (!p) {
      p = (async () => {
        let res: Response;
        try {
          res = await fetchWithBackoff(
            f,
            `${base}/repos/${owner}/${repo}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                "user-agent": "longshore",
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
        if (!res.ok) return; // 404 and the rest surface from the resolution itself
        const info = (await res.json()) as { private?: boolean };
        if (info.private === true) {
          throw new PlanError(
            "private-action",
            `${key} is a private repository; actions from private repositories are not allowed`,
          );
        }
      })();
      checked.set(key, p);
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
