import { z } from "zod";
import { defineOp } from "../define";
import { OpError } from "../errors";

/**
 * Signing a release is a human-only action: it needs a human-signed assertion, so no bearer
 * token can ever satisfy it and the dispatcher refuses it before this handler could run. It is
 * registered so the shape is fixed and every adapter test covers it; the handler is a second
 * refusal, not a path. The signing service itself (see `signing/`) is called by the release
 * lane, not by an API caller, until two-person signed approvals (#46) exist.
 */
export const signRelease = defineOp({
  name: "sign_release",
  summary: "Sign the recorded artifacts of a release run (human-signed assertion required).",
  description:
    "Signs named, recorded artifacts of a finished release run and returns DSSE-signed SLSA " +
    "provenance. It needs a human-signed assertion: a bearer token or agent can never call it. " +
    "The run must be of class release, on a release ref, with its environment's approval; " +
    "artifacts are taken from the artifact store, never supplied by the caller.",
  input: z.object({
    run_id: z.string().min(1).max(64),
    artifacts: z.array(z.string().min(1).max(200)).min(1).max(50),
    environment: z.string().min(1).max(64),
  }),
  output: z.object({ signed: z.boolean() }),
  effect: "write",
  auth: { type: "signature", minRole: "owner" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/runs/{run_id}/sign" },
  async handler() {
    throw new OpError("signature_required", "sign_release requires a human signature");
  },
});
