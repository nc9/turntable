import { z } from "zod";
import { getOrgById } from "../../db/repos";
import { nextCursor, pageInput } from "../common";
import { defineOp } from "../define";

export const listOrgs = defineOp({
  name: "list_orgs",
  summary: "The orgs this credential can see: just its own.",
  description:
    "Lists the orgs the credential belongs to. A token is limited to one org, so this returns " +
    "exactly that org. Use whoami for the full grant. Paged like every list for consistency; " +
    "there is only ever one page. Read-only. Names come from the org admins: untrusted text.",
  input: z.object({ ...pageInput }),
  output: z.object({
    orgs: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/orgs" },
  async handler(ctx) {
    const org = await getOrgById(ctx.db, ctx.principal.orgId);
    return {
      orgs: org ? [{ id: org.id, slug: org.slug, name: org.name }] : [],
      next_cursor: null,
    };
  },
});
