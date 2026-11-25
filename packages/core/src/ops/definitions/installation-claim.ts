import { z } from "zod";
import { ClaimError } from "../../github/claim";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";
import {
  getInstallationClaimInput,
  getInstallationClaimOutput,
  startInstallationClaimExtraInput,
  startInstallationClaimExtraOutput,
} from "../onboarding-schemas";

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
    "release_operator or admin (a project-scoped token is refused with forbidden). Pass " +
    "installation_id for an installation made without a claim link: the link then opens its " +
    "configure page (the App needs Redirect on update enabled). A signed-in web session of an org " +
    "owner or admin may call it too (the onboarding page does): the link only starts a flow, and " +
    "ownership of the GitHub installation is checked when it binds. With popup the page GitHub " +
    "sends the person back to closes itself and tells the window that opened it; the projects " +
    "such a claim creates start paused. claim_id is the id for get_installation_claim. Not " +
    "available over MCP.",
  input: z.object({
    github_login: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .optional()
      .describe("If known, only this GitHub user can complete the claim."),
    installation_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe(
        "Claim an installation that already exists: the link opens its configure page instead of a fresh install.",
      ),
    ...startInstallationClaimExtraInput.shape,
  }),
  output: z.object({
    url: z.string().describe("Open this in a browser to install and connect."),
    expires_at: z.int(),
    ...startInstallationClaimExtraOutput.shape,
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
      const r = await ctx.claims.start(ctx.scope.orgId, principalLabel(ctx.principal), {
        ...(input.github_login ? { expectedLogin: input.github_login } : {}),
        ...(input.installation_id ? { installationId: input.installation_id } : {}),
        ...(input.popup ? { popup: true } : {}),
      });
      return { url: r.url, expires_at: r.expiresAt, claim_id: r.claimId };
    } catch (e) {
      if (e instanceof ClaimError) throw new OpError("unavailable", e.message);
      throw e;
    }
  },
});

export const getInstallationClaimOp = defineOp({
  name: "get_installation_claim",
  summary: "Read where an installation claim of this org stands.",
  description:
    "Returns the state of a claim started with start_installation_claim: pending (the link is " +
    "live), completed (the installation is bound; its id and GitHub account are returned), " +
    "expired, or refused (with the reason). A claim of another org is not found. Poll it, or " +
    "listen for the installation_claim.updated event in the org's feed. Needs a signed-in " +
    "session of the org or an org-level token with release_operator or higher. Not available " +
    "over MCP.",
  input: getInstallationClaimInput,
  output: getInstallationClaimOutput,
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/github/installation-claims/{claim_id}" },
  mcp: false,
  async handler(ctx, input) {
    if (ctx.scope.projectId || (ctx.principal.kind === "token" && ctx.principal.projectId)) {
      throw new OpError("forbidden", "an org-level token is required");
    }
    if (!ctx.claims) {
      throw new OpError("unavailable", "installation claims are not configured");
    }
    const st = await ctx.claims.status(ctx.scope.orgId, input.claim_id);
    if (!st) throw new OpError("not_found", "no such claim");
    return {
      state: st.state,
      ...(st.installationId ? { installation_id: st.installationId } : {}),
      ...(st.accountLogin ? { account_login: st.accountLogin } : {}),
      ...(st.reason ? { reason: st.reason } : {}),
    };
  },
});
