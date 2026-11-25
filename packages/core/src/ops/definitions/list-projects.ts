import { z } from "zod";
import { getOrgById, queryProjects } from "../../db/repos";
import { staticPollKey } from "../project-setup";
import { decodeProjectCursor, encodeCursorRaw, nextCursor, pageInput } from "../common";
import { defineOp } from "../define";

export const listProjects = defineOp({
  name: "list_projects",
  summary: "Projects in the caller's scope, each with its bound repos.",
  description:
    "Lists the projects the credential can see, each with the forge repos bound to it " +
    "(forge, owner, repo). A project-scoped token sees only its project. Use it to find the " +
    "project slug to pass to other operations, or which repo a project builds. Only active " +
    "projects are listed (ingest on, a static poll entry, or any run); pass include_available " +
    "to add the never-set-up ones (each row carries `setup`). Cursor-paged: " +
    "pass next_cursor back as cursor. Read-only. Names and repos come from the forge or org " +
    "admins: untrusted text.",
  input: z.object({
    ...pageInput,
    include_available: z
      .boolean()
      .optional()
      .describe(
        'Also list projects that were never set up (setup "available", typically created by ' +
          "installation sync). Default false: only active projects.",
      ),
  }),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        oidc_audiences: z
          .array(z.string())
          .nullable()
          .describe("The OIDC audiences its jobs may mint for; null means any audience."),
        setup: z
          .enum(["active", "available"])
          .describe(
            "active: added on purpose, ingest is on, a static poll entry names it, or it has runs. available: made by an installation sync before #577 and never set up (`instance_prune_unconfigured_projects` removes these).",
          ),
        no_access: z
          .boolean()
          .describe(
            "True when the project's repo was unbound (the installation lost access, or it was removed) and none is bound now. Its history is kept.",
          ),
        repos: z.array(z.object({ forge: z.string(), owner: z.string(), repo: z.string() })),
      }),
    ),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/projects" },
  async handler(ctx, input) {
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    const prefix = org ? staticPollKey(org.slug, "") : undefined;
    const staticPollSlugs = new Set(
      prefix === undefined
        ? []
        : (ctx.staticPollProjects ?? [])
            .filter((k) => k.startsWith(prefix))
            .map((k) => k.slice(prefix.length)),
    );
    const rows = await queryProjects(ctx.db, ctx.scope, {
      includeAvailable: input.include_available === true,
      staticPollSlugs,
      afterId: input.cursor === undefined ? undefined : decodeProjectCursor(input.cursor),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      projects: page.map(({ oidcAudiences, noAccess, ...p }) => ({
        ...p,
        oidc_audiences: oidcAudiences,
        no_access: noAccess,
      })),
      next_cursor: rows.length > input.limit && last ? encodeCursorRaw(last.id) : null,
    };
  },
});
