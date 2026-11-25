// The credential the worker uses for GitHub when it resolves and verifies actions. Without one,
// those calls are unauthenticated and share GitHub's 60-per-hour limit, which a busy server
// spends in minutes. The order follows how the run was ingested:
//   1. the poll config's token file, for a repo the poller watches;
//   2. an App installation token for the repo's installation, read-only (metadata and contents:
//      read) and NOT limited to one repository, so it can also read public action repos at the
//      installation's 5000-per-hour limit instead of the anonymous 60 (#621). The resolver sends
//      it to a repo other than the run's own only after a fail-closed public check;
//   3. TURNTABLE_GITHUB_TOKEN, only when neither exists.
// Nothing here is logged, and no token is returned by any operation.
import type { Run } from "../db/repos";
import { getOrgById, listProjects, listRepos, type Scope } from "../db/repos";
import type { Db } from "../db";
import { readPollToken } from "../poll/config";

export interface TokenMinter {
  mint(
    installationId: string,
    scope: {
      repositories?: readonly string[];
      permissions?: Readonly<Record<string, "read" | "write">>;
    },
  ): Promise<{ token: string }>;
}

export interface ForgeTokenOptions {
  db: Db;
  /** The poll config: its token file serves the repos it lists. */
  poll?:
    | {
        tokenFile?: string | undefined;
        tokenEnv?: string | undefined;
        /** Each entry lands runs in `org`/`project` (default `local`); the token serves only those. */
        repos: readonly { repo: string; org?: string | undefined; project?: string | undefined }[];
      }
    | undefined;
  /** The GitHub App, when configured. */
  auth?: TokenMinter | undefined;
  /** TURNTABLE_GITHUB_TOKEN, last resort. */
  envToken?: string | undefined;
  log?: (message: string) => void;
}

/**
 * A credential and what it may be used for. `publicActions` is set for an installation token: it
 * is sent for any action repo that a fail-closed check proves public, not only for the run's own
 * repo and the org's allowlisted owners.
 */
export type ForgeCredential = { token: string; publicActions?: boolean };

export type ForgeToken = (ctx: {
  run: Pick<Run, "repo" | "local"> & { id?: string };
  scope: Required<Scope>;
}) => Promise<string | ForgeCredential | undefined>;

/** A bare token (poll, env) or a credential, as one credential. */
export function normalizeForgeToken(
  v: string | ForgeCredential | undefined,
): ForgeCredential | undefined {
  return typeof v === "string" ? { token: v } : v;
}

export function createForgeToken(o: ForgeTokenOptions): ForgeToken {
  const log = o.log ?? (() => {});
  let warnedUnauthenticated = false;
  const logged = new Set<string>();
  const unauthenticated = (): undefined => {
    if (!warnedUnauthenticated) {
      warnedUnauthenticated = true;
      log(
        "no GitHub credential for resolving actions (no poll token, no App installation, no TURNTABLE_GITHUB_TOKEN): requests are unauthenticated and limited to 60 per hour",
      );
    }
    return undefined;
  };
  return async ({ run, scope }) => {
    const repo = run.repo?.toLowerCase();
    if (!run.local && repo) {
      // The poll token serves a run only when the poll entry for that repo lands runs in this
      // very org and project: the same repo bound in another tenant must not borrow it.
      let watched = false;
      if (
        (o.poll?.tokenFile || o.poll?.tokenEnv) &&
        o.poll.repos.some((r) => r.repo.toLowerCase() === repo)
      ) {
        const org = await getOrgById(o.db, scope.orgId);
        const project = (await listProjects(o.db, scope)).find((p) => p.id === scope.projectId);
        watched = o.poll.repos.some(
          (r) =>
            r.repo.toLowerCase() === repo &&
            (r.org ?? "local") === org?.slug &&
            (r.project ?? "local") === project?.slug,
        );
      }
      if (watched && o.poll) {
        try {
          return readPollToken(o.poll);
        } catch (err) {
          log(`poll token unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (o.auth) {
        const [owner, name] = repo.split("/") as [string, string];
        const bound = (await listRepos(o.db, scope)).find(
          (r) => r.forge === "github" && r.owner === owner && r.repo === name,
        );
        if (bound?.installationId) {
          try {
            // Read-only and not limited to one repository: enough to resolve refs and compare
            // commits in the run's repo and in any public action repo. Minted (and cached) by
            // the App auth; it stays in the control plane and is never logged or sent to a job.
            const { token } = await o.auth.mint(bound.installationId, {
              permissions: { metadata: "read", contents: "read" },
            });
            const seen = `${run.id ?? repo}`;
            if (!logged.has(seen)) {
              logged.add(seen);
              log(`resolving actions for ${repo} with its App installation token`);
            }
            return { token, publicActions: true };
          } catch (err) {
            log(
              `could not mint an installation token for ${repo}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
    if (o.envToken) return o.envToken;
    return unauthenticated();
  };
}
