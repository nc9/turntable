import { z } from "zod";
import { forApi } from "../../doctor/types";
import { OpError } from "../errors";
import { defineOp } from "../define";

const STATUS = z.enum(["pass", "warn", "fail"]);

export const doctor = defineOp({
  name: "doctor",
  summary: "Read-only readiness check of this instance: pass, warn or fail, with a fix for each.",
  description:
    "Checks whether this Turntable instance is ready to go live and says what to fix: the " +
    "privilege drop and data directory, the master key, the database and its migrations, the " +
    "GitHub App credentials, the sandbox provider (credentials, account and snapshot, without " +
    "creating a sandbox), the secrets proxy's TLS certificate, the forwarded-header settings " +
    "against the traffic it has seen, the https redirect, the release channel, and quotas. Use " +
    "it before opening an instance to other people and after changing its configuration. Every " +
    "finding is pass, warn or fail with a one-line fix. It changes nothing and never returns a " +
    "secret value, only whether one is present and well formed.",
  input: z.object({}),
  output: z.object({
    status: STATUS.describe("The worst status of any check."),
    counts: z.object({ pass: z.int(), warn: z.int(), fail: z.int() }),
    checks: z.array(
      z.object({
        id: z.string(),
        area: z.string(),
        status: STATUS,
        summary: z.string(),
        fix: z.string().optional().describe("What to do about it, when it is not a pass."),
      }),
    ),
  }),
  effect: "read",
  // Instance-wide facts (master key, App credentials, provider, proxy TLS, release channel): no
  // agent token and no org role below owner may read them. Tokens never hold owner, so this is
  // reachable only by a trusted in-process caller, and the op is left out of MCP and OpenAPI.
  auth: { type: "token", minRole: "owner" },
  roleNote: "Instance operators only: run `turntable doctor` on the host.",
  // Findings carry fixed sentences only: raw error text stays in the local CLI.
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/doctor" },
  async handler(ctx) {
    if (ctx.principal.kind !== "member" || ctx.principal.role !== "owner") {
      throw new OpError("forbidden", "doctor is for the instance operator");
    }
    if (!ctx.doctor) {
      return {
        status: "warn" as const,
        counts: { pass: 0, warn: 1, fail: 0 },
        checks: [
          {
            id: "doctor",
            area: "doctor",
            status: "warn" as const,
            summary: "this server does not serve doctor over its API",
            fix: "Run `turntable doctor` on the host.",
          },
        ],
      };
    }
    return forApi(await ctx.doctor());
  },
});
