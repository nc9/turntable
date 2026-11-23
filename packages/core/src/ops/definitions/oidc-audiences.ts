import { z } from "zod";
import { setProjectOidcAudiences } from "../../db/repos";
import { validAudience } from "../../oidc/issuer";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const setOidcAudiencesOp = defineOp({
  name: "set_oidc_audiences",
  summary: "Limit the OIDC audiences a project's jobs may ask for, or lift the limit.",
  description:
    "Sets the list of audiences (`aud`) a job of one project may mint an OIDC identity token " +
    "for. With a list, a request for any other audience is refused and audited; without one " +
    "(`audiences: null`, the default) any audience is allowed to a job that may mint at all. " +
    "Set it to the audiences your cloud trust policies actually name (for example the AWS STS " +
    "audience or your Vault role's), so a compromised job cannot get a token for a relying " +
    "party it has no business with. Each audience is one printable string of up to 256 " +
    "characters; up to 20. Pass the project. Org admins only (no agent token); audited.",
  input: z.object({
    audiences: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(20)
      .nullable()
      .describe("The allowed audiences, or null to allow any."),
  }),
  output: z.object({
    project: z.string(),
    oidc_audiences: z.array(z.string()).nullable(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/oidc-audiences" },
  async handler(ctx, input) {
    if (ctx.principal.kind !== "member") {
      throw new OpError("forbidden", "only org members can change the OIDC audiences");
    }
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const list = input.audiences === null ? null : [...new Set(input.audiences)];
    for (const a of list ?? []) {
      if (!validAudience(a)) {
        throw new OpError(
          "invalid_input",
          "an audience is one printable string with no spaces, up to 256 characters",
        );
      }
    }
    if (!(await setProjectOidcAudiences(ctx.db, ctx.scope, list))) {
      throw new OpError("not_found", "no such project");
    }
    return { project: ctx.scope.projectId, oidc_audiences: list };
  },
});
