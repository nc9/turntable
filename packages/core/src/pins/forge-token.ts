// The credential the worker uses for GitHub when it resolves and verifies actions. Without one,
// those calls are unauthenticated and share GitHub's 60-per-hour limit, which a busy server
// spends in minutes. The order follows how the run was ingested:
//   1. the poll config's token file, for a repo the poller watches;
//   2. an App installation token minted read-only for that one repo (contents: read);
//   3. LONGSHORE_GITHUB_TOKEN, only when neither exists.
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
  /** LONGSHORE_GITHUB_TOKEN, last resort. */
  envToken?: string | undefined;
  log?: (message: string) => void;
}

export type ForgeToken = (ctx: {
  run: Pick<Run, "repo" | "local">;
  scope: Required<Scope>;
}) => Promise<string | undefined>;

export function createForgeToken(o: ForgeTokenOptions): ForgeToken {
  const log = o.log ?? (() => {});
  let warnedUnauthenticated = false;
  const unauthenticated = (): undefined => {
    if (!warnedUnauthenticated) {
      warnedUnauthenticated = true;
      log(
        "no GitHub credential for resolving actions (no poll token, no App installation, no LONGSHORE_GITHUB_TOKEN): requests are unauthenticated and limited to 60 per hour",
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
            // Read-only, one repository: enough to resolve refs and compare commits.
            const { token } = await o.auth.mint(bound.installationId, {
              repositories: [name],
              permissions: { contents: "read" },
            });
            return token;
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
