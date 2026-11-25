import { z } from "zod";
import {
  createReleaseRequest,
  getFreeze,
  getReleaseRequest,
  getRun,
  type ReleaseRequest,
} from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { orgRole } from "../principal";
import { roleSatisfies } from "../roles";

const requestView = z.object({
  id: z.string(),
  run_id: z.string(),
  tag: z.string(),
  artifacts: z.array(z.string()),
  status: z
    .enum(["pending", "claimed", "signed", "verified", "refused", "error"])
    .describe(
      "verified: a dry run that passed every check (nothing was signed or published); signed: the lane signed.",
    ),
  dry_run: z.boolean().describe("True for a request made with dry_run: it signs nothing."),
  reason: z.string().nullable().describe("Why the release lane refused, as a short code."),
  created_at: z.int(),
  finished_at: z.int().nullable(),
  key_id: z.string().nullable().describe("The id of the key that signed, when it signed."),
  cosignatures: z
    .array(
      z.object({
        name: z.string(),
        file: z
          .string()
          .optional()
          .describe("The manifest's binary this signature is over, when it is not the manifest."),
        status: z
          .enum(["present", "verified", "missing", "invalid", "unexpected"])
          .describe(
            "present: carried, not yet checked by the lane. verified/missing/invalid/unexpected: the lane's verdict.",
          ),
        key_id: z
          .string()
          .optional()
          .describe("Public-key fingerprint of the configured co-signing key. Never key material."),
        reason: z.string().optional(),
      }),
    )
    .describe("Co-signature status of the request: what was carried and what the lane found."),
});

const getView = requestView.extend({
  plan: z
    .object({
      targets: z.array(z.record(z.string(), z.unknown())),
      note: z.string().optional(),
    })
    .nullable()
    .describe(
      "For a dry run that passed: the publish plan, the configured targets in publish order with the assets each would publish (or `none configured`). Null otherwise.",
    ),
  provenance: z
    .string()
    .nullable()
    .describe(
      "The lane's signed DSSE envelope (the provenance) as JSON text, for a signed request; null otherwise. Verify it against the pinned public key (release_public_key, `turntable verify --pubkey`); the server's copy is not trusted, the signature is.",
    ),
});

/** The signed envelope the lane recorded in the request's result, as JSON text, or null. */
function provenanceOf(r: ReleaseRequest): string | null {
  if (r.status !== "signed" || r.dryRun || !r.result) return null;
  const envelope = (JSON.parse(r.result) as { envelope?: unknown }).envelope;
  return envelope === undefined || envelope === null ? null : JSON.stringify(envelope);
}

/** The dry run's publish plan the lane recorded in the request's result, or null. */
function planOf(r: ReleaseRequest): z.infer<typeof getView>["plan"] {
  if (!r.dryRun || r.status !== "signed" || !r.result) return null;
  const plan = (JSON.parse(r.result) as { plan?: z.infer<typeof getView>["plan"] }).plan;
  return plan ?? null;
}

type CosignView = z.infer<typeof requestView>["cosignatures"];

/** The lane's verdict (written to facts) over what the request carried; read-only, no config. */
function cosignView(r: ReleaseRequest): CosignView {
  const carried = r.cosignatures
    ? (JSON.parse(r.cosignatures) as { name: string; file?: string }[]).map((c) => ({
        name: c.name,
        ...(c.file === undefined ? {} : { file: c.file }),
      }))
    : [];
  let reports: CosignView = [];
  try {
    reports = r.facts
      ? ((JSON.parse(r.facts) as { cosignatures?: CosignView }).cosignatures ?? [])
      : [];
  } catch {
    reports = [];
  }
  if (reports.length > 0) return reports;
  return carried.map((c) => ({ ...c, status: "present" as const }));
}

const view = (r: ReleaseRequest): z.infer<typeof requestView> => ({
  id: r.id,
  run_id: r.runId,
  tag: r.tag,
  artifacts: JSON.parse(r.artifacts) as string[],
  status: (r.dryRun && r.status === "signed" ? "verified" : r.status) as z.infer<
    typeof requestView
  >["status"],
  dry_run: r.dryRun === true,
  reason: r.reason,
  created_at: r.createdAt,
  finished_at: r.finishedAt,
  cosignatures: cosignView(r),
  key_id: r.result ? ((JSON.parse(r.result) as { keyid?: string }).keyid ?? null) : null,
});

export const requestReleaseOp = defineOp({
  name: "request_release",
  summary: "Ask the release lane to sign the artifacts of a tagged run.",
  description:
    "Queues a request for the release lane, a separate process that holds the signing keys. The " +
    "request names a run, the tag being released, the artifact names (never an approval environment: that is the project's own setting). It is " +
    "only a request: the release lane re-checks with the forge that the tag points at the run's " +
    "commit and recomputes the artifact digests itself, so nothing here can make it sign " +
    "something it cannot verify. Optional cosignatures (name, signature_b64) carry co-signatures " +
    "made off-instance by a client-pinned key; the lane alone verifies them against its " +
    "configured public keys and refuses to sign or publish when a configured one is missing or " +
    "bad. Poll get_release_request for the outcome. With dry_run: true the lane verifies " +
    "everything (the run is finished, successful and built from the tag, every digest, the " +
    "manifest and every .sig, the version, the signing key) and returns the publish plan, and " +
    "signs and publishes nothing; it needs no approval and spends none. Needs one project and " +
    "release_operator or admin (operator too, for a dry run); audited. Not available over MCP.",
  input: z.object({
    run_id: z.string().min(1).max(40),
    tag: z.string().min(1).max(200),
    artifacts: z.array(z.string().min(1).max(200)).min(1).max(50),
    dry_run: z
      .boolean()
      .optional()
      .describe("Verify and plan only: nothing is signed or published, no approval is spent."),
    cosignatures: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          file: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/)
            .optional()
            .describe(
              "For a key with a manifest check: the binary this signature is over. Absent: the key's own signed file (the manifest).",
            ),
          signature_b64: z.string().min(1).max(4096),
        }),
      )
      .max(100)
      .optional()
      .describe(
        "Co-signatures by a key your clients pin, made off-instance over the exact bytes of the " +
          "configured artifact. The release lane verifies each against its configured public keys.",
      ),
  }),
  output: requestView,
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/release-requests" },
  mcp: false,
  async handler(ctx, i) {
    // The op is open to an operator for a dry run only: asking the lane to sign needs release_operator.
    if (!i.dry_run && !roleSatisfies(orgRole(ctx.principal), "release_operator")) {
      throw new OpError(
        "forbidden",
        "requesting a release needs release_operator (a dry run needs operator)",
      );
    }
    if ((await getFreeze(ctx.db, ctx.scope)).frozen) {
      throw new OpError("conflict", "this org or project is frozen; releases are paused");
    }
    const run = await getRun(ctx.db, ctx.scope, i.run_id);
    if (!run) throw new OpError("not_found", "no such run in this project");
    const row = await createReleaseRequest(ctx.db, ctx.scope, {
      runId: i.run_id,
      tag: i.tag,
      artifacts: i.artifacts,
      ...(i.cosignatures ? { cosignatures: i.cosignatures } : {}),
      ...(i.dry_run ? { dryRun: true } : {}),
      requestedBy: `${ctx.principal.kind}:${ctx.principal.id}`,
    });
    return view(row);
  },
});

export const getReleaseRequestOp = defineOp({
  name: "get_release_request",
  summary: "The state of a release request: pending, signed, or refused with a reason.",
  description:
    "Returns one release request by id: its status (pending, claimed, signed, refused, error), the " +
    "refusal reason as a short code when the release lane refused it, and the key id when it " +
    "signed, and for a signed request `provenance`: the lane's signed DSSE envelope as JSON text " +
    "(null otherwise), which a consumer verifies against the pinned public key, and the " +
    "co-signature status (present, verified, missing, invalid) with public-key fingerprints " +
    "only. Needs one project and release_operator or admin. Read-only.",
  input: z.object({ id: z.string().min(1).max(40) }),
  output: getView,
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/release-requests/{id}" },
  async handler(ctx, i) {
    const r = await getReleaseRequest(ctx.db, ctx.scope, i.id);
    if (!r) throw new OpError("not_found", "no such release request");
    return { ...view(r), provenance: provenanceOf(r), plan: planOf(r) };
  },
});
