// The GitHub token a job gets as GITHUB_TOKEN: an installation token minted for this one job, for
// this one repository, with the permissions its workflow declared, capped by the run's trust
// class and by what the App's installation was granted, and revoked when the job ends. It is
// never cached or shared with another job, and never returned by any operation.
import {
  DEFAULT_PERMISSIONS,
  declaredPermissions,
  isMappablePermission,
  type PermissionLevel,
} from "@turntable/act-runner";
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { TrustClass } from "../trust";

export type Permissions = Record<string, PermissionLevel>;

export interface CappedPermissions {
  permissions: Permissions;
  /** What was lowered or dropped, and why, for the job's log. */
  notes: string[];
}

/**
 * What the token may carry:
 * - `untrusted_pr`: contents read, whatever the workflow asked for;
 * - `trusted_pr`: what was asked for, but never write;
 * - `protected` and `release`: what was asked for;
 * then never more than the installation was granted (`granted`, when known). `metadata: read` is
 * always present, since GitHub grants it with every installation token. There is no id-token
 * here: Turntable's own OIDC issuer is the way to ask for one.
 */
export function capPermissions(
  declared: Readonly<Record<string, PermissionLevel>>,
  klass: TrustClass,
  granted?: Readonly<Record<string, string>>,
): CappedPermissions {
  const notes: string[] = [];
  // Only names an installation token can carry; id_token and the like never get through.
  let want: Permissions = Object.fromEntries(
    Object.entries(declared).filter(([k]) => isMappablePermission(k)),
  );
  if (klass === "untrusted_pr") {
    const extra = Object.keys(want).filter((k) => k !== "contents" || want[k] !== "read");
    if (extra.length > 0) {
      notes.push(`an untrusted pull request gets contents read only (not ${extra.join(", ")})`);
    }
    want = { contents: "read" };
  } else if (klass === "trusted_pr") {
    for (const [k, v] of Object.entries(want)) {
      if (v === "write") {
        want[k] = "read";
        notes.push(`${k}: write lowered to read for a pull request`);
      }
    }
  }
  if (granted) {
    for (const [k, v] of Object.entries(want)) {
      const have = granted[k];
      if (have === undefined) {
        delete want[k];
        notes.push(`${k}: the App installation was not granted it; dropped`);
      } else if (v === "write" && have === "read") {
        want[k] = "read";
        notes.push(`${k}: the App installation has read only; lowered to read`);
      }
    }
  }
  return { permissions: { metadata: "read", ...want }, notes };
}

/** The pieces of AppAuth this needs (so tests can supply a fake GitHub). */
export interface TokenAuthority {
  mintFresh(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string; expiresAt: number }>;
  installationPermissions(installationId: string): Promise<Readonly<Record<string, string>>>;
  revoke(token: string): Promise<boolean>;
}

export interface IssuedJobToken {
  token: string;
  expiresAt: number;
  permissions: Permissions;
  notes: string[];
  /** Revokes it at GitHub. Idempotent, never throws. */
  revoke(): Promise<void>;
}

export interface IssueRequest {
  installationId: string;
  /** The repository's owner, for the visibility check. */
  owner: string;
  /** The repository name, without the owner. */
  repo: string;
  klass: TrustClass;
  workflowYaml: string;
  jobId: string;
}

/** Why no token was minted, for the job's log. */
export interface NoToken {
  none: string;
}

export interface JobTokensOptions {
  /**
   * Whether a repository is public. A job on a public repo whose token would carry nothing beyond
   * contents read and metadata read gets none: its source is delivered by the controller, and a
   * token would only make it a secret-bearing job. Unknown means private.
   */
  isPublic?:
    | ((owner: string, repo: string, installationId: string) => Promise<boolean>)
    | undefined;
}

/** True when the permissions are nothing beyond `contents: read` and `metadata: read`. */
export const isReadOnlyContents = (p: Readonly<Record<string, string>>): boolean =>
  Object.entries(p).every(([k, v]) => v === "read" && (k === "contents" || k === "metadata"));

export class JobTokens {
  readonly #auth: TokenAuthority;
  readonly #isPublic:
    | ((owner: string, repo: string, installationId: string) => Promise<boolean>)
    | undefined;

  constructor(auth: TokenAuthority, o: JobTokensOptions = {}) {
    this.#auth = auth;
    this.#isPublic = o.isPublic;
  }

  /**
   * Mints the job's token, or says why not. A token is minted only when the capped permissions
   * need one: any write scope, a scope beyond contents read, or a private repository (contents
   * read is needed to fetch it).
   */
  async issue(r: IssueRequest): Promise<IssuedJobToken | NoToken> {
    const declared = declaredPermissions(r.workflowYaml, r.jobId);
    let granted: Readonly<Record<string, string>> | undefined;
    try {
      granted = await this.#auth.installationPermissions(r.installationId);
    } catch {
      // Unknown grant: the token request itself is the check; GitHub refuses a wider one.
      granted = undefined;
    }
    const capped = capPermissions(
      declared.declared ? declared.permissions : DEFAULT_PERMISSIONS,
      r.klass,
      granted,
    );
    if (isReadOnlyContents(capped.permissions)) {
      let pub = false;
      try {
        pub = (await this.#isPublic?.(r.owner, r.repo, r.installationId)) ?? false;
      } catch {
        pub = false;
      }
      if (pub) {
        return {
          none: `no token: ${r.owner}/${r.repo} is public and the job needs nothing beyond contents read, which the controller already delivers`,
        };
      }
    }
    const minted = await this.#auth.mintFresh(r.installationId, {
      repositories: [r.repo],
      permissions: capped.permissions as Record<string, "read" | "write">,
    });
    let revoked = false;
    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      permissions: capped.permissions,
      notes: [...declared.notes, ...capped.notes],
      revoke: async () => {
        if (revoked) return;
        revoked = true;
        await this.#auth.revoke(minted.token);
      },
    };
  }
}

/** What the visibility check needs from the App: a cached read-only token, and the API base. */
export interface VisibilityAuth {
  mint(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string }>;
  readonly apiBase: string;
}

/**
 * Public or private, asked of GitHub as the App: an installation token read-only for that one
 * repository (the same cached one the action pin checks use), then `GET /repos/{owner}/{repo}`.
 * Authenticated, so it does not spend GitHub's 60-per-hour anonymous limit. Only `private: false`
 * is public; anything else (a failed mint, an error, a rate limit) is "not public", and only a
 * clear answer is remembered, for ten minutes.
 */
export function publicRepoCheck(o: {
  auth: VisibilityAuth;
  fetch?: SafeFetch;
  now?: () => number;
  ttlMs?: number;
}): (owner: string, repo: string, installationId: string) => Promise<boolean> {
  const cache = new Map<string, { at: number; pub: boolean }>();
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 10 * 60_000;
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  return async (owner, repo, installationId) => {
    if (!plain.test(owner) || !plain.test(repo)) return false;
    const key = `${installationId}/${owner}/${repo}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.pub;
    try {
      const { token } = await o.auth.mint(installationId, {
        repositories: [repo],
        permissions: { contents: "read" },
      });
      const res = await (o.fetch ?? safeFetch)(`${o.auth.apiBase}/repos/${owner}/${repo}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 200) return false;
      const pub = ((await res.json()) as { private?: boolean }).private === false;
      cache.set(key, { at: now(), pub });
      return pub;
    } catch {
      return false;
    }
  };
}
