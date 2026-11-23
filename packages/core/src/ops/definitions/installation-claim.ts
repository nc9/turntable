import { z } from "zod";
import { ClaimError } from "../../github/claim";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const startInstallationClaim = defineOp({
  name: "start_installation_claim",
  summary: "Get the link that connects a GitHub installation to this org.",
  description:
    "Starts a claim for this org and returns a link carrying a signed, single-use state that " +
    "binds the installation to the org of the caller. The link opens a confirmation page on this " +
    "Turntable instance that names the org; confirming sets a cookie that binds the flow to that " +
    "browser and sends it to GitHub. The person must install (or configure) the App and be " +
    "signed in to GitHub; Turntable then checks that they OWN the installation (an admin of the " +
    "organization, or the user the personal account belongs to) before it binds it, and audits " +
    "who claimed it. The link expires in 15 minutes. Needs an org-level token with " +
    "release_operator or admin (a project-scoped token is refused with forbidden). Not " +
    "available over MCP.",
  input: z.object({
    github_login: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .optional()
      .describe("If known, only this GitHub user can complete the claim."),
  }),
  output: z.object({
    url: z.string().describe("Open this in a browser to install and connect."),
    expires_at: z.int(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/github/installation-claims" },
  mcp: false,
  async handler(ctx, input) {
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId)) {
      throw new OpError("forbidden", "an org-level token is required");
    }
    if (!ctx.claims) {
      throw new OpError(
        "unavailable",
        "installation claims are not configured: start the server with TURNTABLE_MASTER_KEY_FILE and a GitHub App",
      );
    }
    try {
      const r = await ctx.claims.start(
        ctx.scope.orgId,
        `${ctx.principal.kind}:${ctx.principal.id}`,
        input.github_login ? { expectedLogin: input.github_login } : {},
      );
      return { url: r.url, expires_at: r.expiresAt };
    } catch (e) {
      if (e instanceof ClaimError) throw new OpError("unavailable", e.message);
      throw e;
    }
  },
});
