import { z } from "zod";
import { queryProjects } from "../../db/repos";
import { decodeProjectCursor, encodeCursorRaw, nextCursor, pageInput } from "../common";
import { defineOp } from "../define";

export const listProjects = defineOp({
  name: "list_projects",
  summary: "Projects in the caller's scope, each with its bound repos.",
  description:
    "Lists the projects the credential can see, each with the forge repos bound to it " +
    "(forge, owner, repo). A project-scoped token sees only its project. Use it to find the " +
    "project slug to pass to other operations, or which repo a project builds. Cursor-paged: " +
    "pass next_cursor back as cursor. Read-only. Names and repos come from the forge or org " +
    "admins: untrusted text.",
  input: z.object({ ...pageInput }),
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
    const rows = await queryProjects(ctx.db, ctx.scope, {
      afterId: input.cursor === undefined ? undefined : decodeProjectCursor(input.cursor),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      projects: page.map(({ oidcAudiences, ...p }) => ({ ...p, oidc_audiences: oidcAudiences })),
      next_cursor: rows.length > input.limit && last ? encodeCursorRaw(last.id) : null,
    };
  },
});
