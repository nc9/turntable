// The GitHub App's state, read-only, in two views (#364). The instance administrator sees the App
// itself and the installation counts; an org sees only whether it owns the App and its own claimed
// installations. They are two ops because instance and org principals never meet in the
// dispatcher. Neither returns credential material: only whether it is sealed.
import { z } from "zod";
import {
  countInstallationsByStatus,
  getGithubApp,
  getOrgById,
  getSecretRecord,
  listInstallationBindings,
  listInstallationPermissions,
  listInstallations,
  listUnclaimedInstallationIds,
} from "../../db/repos";
import {
  missingPermissions,
  SECRET_APP_ID,
  SECRET_PRIVATE_KEY,
  SECRET_WEBHOOK,
} from "../../github/app-auth";
import { APP_PERMISSIONS } from "../../github/manifest";
import { iso } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";

/** The most unclaimed installation ids the instance view lists. */
const UNCLAIMED_CAP = 100;
/** The most installations whose permission state is checked in one call. */
const PERMISSION_CAP = 5000;

/**
 * Whether each installation has accepted the App's current permission set, from the set stored at
 * the last sync (refreshed by the `new_permissions_accepted` webhook). `pending` lists those that
 * have not, with the missing permissions; `unknown` counts installations not read since this
 * was added.
 */
async function permissionState(db: Parameters<typeof listInstallationPermissions>[0]) {
  const rows = await listInstallationPermissions(db, PERMISSION_CAP);
  let current = 0;
  let unknown = 0;
  const pending: { installation_id: string; account_login: string; missing: string[] }[] = [];
  for (const r of rows) {
    if (r.permissions === null) {
      unknown += 1;
      continue;
    }
    const missing = missingPermissions(r.permissions, APP_PERMISSIONS);
    if (missing.length === 0) current += 1;
    else if (pending.length < UNCLAIMED_CAP) {
      pending.push({ installation_id: r.installationId, account_login: r.accountLogin, missing });
    }
  }
  const pendingTotal = rows.length - current - unknown;
  return { current, pending_acceptance: pendingTotal, unknown, pending };
}

export const instanceGithubAppStatus = defineOp({
  name: "instance_github_app_status",
  summary: "The GitHub App's state on this instance, for the instance administrator.",
  description:
    "Reports whether a GitHub App is configured and, if so, its id, slug, owner login, the org " +
    "that owns it, when it was created, whether its credentials (private key, webhook secret) are " +
    "sealed in the store (a boolean: the material is never returned), installation counts by " +
    "status, per installation whether it has accepted the App's current permission set or is pending " +
    "acceptance (and which permissions it lacks; an owner accepts on GitHub), and the ids of installations a webhook named that no org has claimed (up to 100, " +
    "newest first). Use it after the manifest flow to confirm the result without a shell. Only " +
    "the instance administrator can call it. Not an MCP tool. Read-only.",
  input: z.object({}),
  output: z.object({
    configured: z.boolean(),
    app: z
      .object({
        app_id: z.string(),
        slug: z.string(),
        owner_login: z.string(),
        owning_org: z.string().nullable(),
        created_at: z.string().nullable(),
        sealed: z.boolean(),
      })
      .nullable(),
    installations: z.object({ active: z.int(), suspended: z.int(), deleted: z.int() }),
    permissions: z.object({
      current: z.int().describe("Installations on the App's current permission set."),
      pending_acceptance: z.int().describe("Installations whose owner has not accepted it yet."),
      unknown: z.int().describe("Installations whose accepted set has not been read yet."),
      pending: z
        .array(
          z.object({
            installation_id: z.string(),
            account_login: z.string(),
            missing: z.array(z.string()).describe("Permission:level the installation lacks."),
          }),
        )
        .describe("Up to 100 installations pending acceptance."),
    }),
    unclaimed_installation_ids: z.array(z.string()),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/instance/github-app" },
  mcp: false,
  async handler(ctx) {
    const app = await getGithubApp(ctx.db);
    const installations = await countInstallationsByStatus(ctx.db);
    const unclaimed = await listUnclaimedInstallationIds(ctx.db, UNCLAIMED_CAP);
    if (!app) {
      return {
        configured: false,
        app: null,
        installations,
        permissions: await permissionState(ctx.db),
        unclaimed_installation_ids: unclaimed,
      };
    }
    const scope = { orgId: app.orgId };
    const sealed = await Promise.all(
      [SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK].map((n) =>
        getSecretRecord(ctx.db, scope, n),
      ),
    );
    const org = await getOrgById(ctx.db, app.orgId);
    return {
      configured: true,
      app: {
        app_id: app.appId,
        slug: app.slug,
        owner_login: app.ownerLogin,
        owning_org: org?.slug ?? null,
        created_at: iso(app.createdAt),
        sealed: sealed.every((r) => r !== undefined),
      },
      installations,
      permissions: await permissionState(ctx.db),
      unclaimed_installation_ids: unclaimed,
    };
  },
});

export const githubAppStatus = defineOp({
  name: "github_app_status",
  summary: "Whether this org owns the GitHub App, and its own installations and bound repos.",
  description:
    "Reports whether this org owns the instance's GitHub App, and lists the installations this " +
    "org has claimed (account, status, repository selection) with the repos bound through each. " +
    "Only this org's own installations appear: another org's, and the App's other details, are " +
    "not shown. Use it to check that a claim took and which repos an installation serves. Needs " +
    "an org-level token with release_operator or admin (a project-scoped token is refused with " +
    "forbidden). Read-only.",
  input: z.object({}),
  output: z.object({
    owns_app: z.boolean(),
    installations: z.array(
      z.object({
        installation_id: z.string(),
        account_login: z.string(),
        account_type: z.string(),
        repository_selection: z.string(),
        status: z.string(),
        repos: z.array(z.string()).describe("Bound repos, as owner/repo."),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/github/app" },
  async handler(ctx) {
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId)) {
      throw new OpError("forbidden", "an org-level token is required");
    }
    const app = await getGithubApp(ctx.db);
    const rows = await listInstallations(ctx.db, ctx.scope);
    const installations = [];
    for (const r of rows) {
      const bound = await listInstallationBindings(ctx.db, ctx.scope, r.installationId);
      installations.push({
        installation_id: r.installationId,
        account_login: r.accountLogin,
        account_type: r.accountType,
        repository_selection: r.repositorySelection,
        status: r.status,
        repos: bound.map((b) => `${b.owner}/${b.repo}`).toSorted(),
      });
    }
    return { owns_app: app?.orgId === ctx.scope.orgId, installations };
  },
});
