// Org owners edit their org's `approval_policy` (#664). The registry's own `set_setting` refuses
// it to every org principal (it is `instanceAdminOnly`), so the owner's web editor has its own
// op: an owner's SESSION only (no org token, no agent, no MCP). Tightening needs the session. A
// loosening also needs a passkey step-up bound to the exact change and, when the org has two or
// more counted approvers, a quorum of them who signed the same statement
// (`approval_policy_challenge`, `approve_approval_policy`). Env and `turntable.toml` locks hold.
import { z } from "zod";
import {
  approvalPolicyQuorumState,
  approvalPolicySnapshot,
  nextEnvEntry,
} from "../../approvals/apply";
import {
  approvalPolicyLoosening,
  approvalPolicyMap,
  effective,
  type ApprovalPolicyMap,
} from "../../approvals/policy-setting";
import { APPROVAL_POLICY_STATEMENT_TYPE, approvalPolicyDigest } from "../../approvals/statement";
import { appendAudit, activeIdentities, getKeyPolicy, getOrgById } from "../../db/repos";
import { resolveApprovalPolicies } from "../../db/repos/approvals";
import { getStoredSetting, lockSettingKey, putStoredSetting } from "../../db/repos/settings";
import { approvalPolicySetting } from "../../settings/definitions";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { recordSettingChange } from "../setting-audit";

const entryView = z.object({
  environment: z.string(),
  required: z.int(),
  allow_author_approval: z.boolean(),
  key_policy: z.enum(["any", "hardware"]),
  gated: z.boolean().describe("Whether a job in this environment waits for approval at all."),
  source: z.enum(["configured", "default"]),
});

const policyView = z.object({
  environments: z
    .array(entryView)
    .describe(
      "Every environment with an entry, plus `production` and `release`, defaults filled in.",
    ),
  source: z.enum(["env", "toml", "db", "default"]),
  locked: z.boolean(),
  locked_by: z.string().nullable().describe("For a locked policy, the variable or file."),
  approvers: z.int().describe("Counted approvers: two or more means a loosening needs a quorum."),
});

function viewOf(
  r: {
    value: ApprovalPolicyMap;
    source: "env" | "toml" | "db" | "default";
    locked: boolean;
    origin?: string | undefined;
  },
  approvers: number,
) {
  const names = [...new Set([...Object.keys(r.value), "production", "release"])].toSorted();
  return {
    environments: names.map((environment) => {
      const e = effective(r.value, environment);
      return {
        environment,
        required: e.entry.required,
        allow_author_approval: e.entry.allow_author_approval,
        key_policy: e.entry.key_policy,
        gated: e.gated,
        source: r.value[environment] ? ("configured" as const) : ("default" as const),
      };
    }),
    source: r.source,
    locked: r.locked,
    locked_by: !r.locked ? null : r.source === "env" ? (r.origin ?? "env") : "turntable.toml",
    approvers,
  };
}

export const getApprovalPolicyOp = defineOp({
  name: "get_approval_policy",
  summary: "The org's effective approval policy per environment, with its source and lock.",
  description:
    "Returns, for every environment with an entry and for `production` and `release`, the " +
    "approvers required, whether the author may approve and the key policy, with the built-in " +
    "defaults filled in, which layer the policy comes from (`env`, `toml`, `db`, `default`) and " +
    "whether it is locked. Also how many approvers count, which decides whether loosening needs " +
    "a signed quorum. For an org owner. Read-only.",
  input: z.object({}),
  output: policyView,
  effect: "read",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/approval-policy" },
  mcp: false,
  async handler(ctx) {
    const r = await resolveApprovalPolicies(ctx.db, ctx.scope.orgId, ctx.settings);
    const counted = await activeIdentities(
      ctx.db,
      ctx.scope.orgId,
      await getKeyPolicy(ctx.db, ctx.scope.orgId),
    );
    return viewOf(r, counted.length);
  },
});

export const setApprovalPolicyOp = defineOp({
  name: "set_approval_policy",
  summary: "Set one environment's approval policy (org owner, web session).",
  description:
    "Sets one environment's entry of `approval_policy`: `required` distinct approvers, " +
    "`allow_author_approval` and optionally `key_policy`. Only an owner's signed-in web session " +
    "may call it: an org token, an agent and MCP are refused. Tightening (more approvers, the " +
    "author excluded, a hardware key policy) needs only that session. Loosening needs a passkey " +
    "step-up bound to exactly this input (`step_up_required` without one) and, when the org has " +
    "two or more counted approvers, signatures from a quorum of them over the same change " +
    "(`approver_quorum_required`; see approval_policy_challenge and approve_approval_policy). " +
    "Refused when the environment or turntable.toml sets the policy. Audited in the org's chain " +
    "with the old and new values. The instance administrator's recovery path is " +
    "instance_set_setting, which audits a loosening loudly.",
  input: z.object({
    environment: z.string().min(1).max(100),
    required: z.int().min(1).max(10),
    allow_author_approval: z.boolean().default(false),
    key_policy: z.enum(["any", "hardware"]).optional(),
  }),
  output: policyView,
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approval-policy" },
  mcp: false,
  async handler(ctx, i) {
    if (ctx.principal.kind !== "session") {
      throw new OpError(
        "forbidden",
        "approval_policy is changed by an org owner from a signed-in web session",
        { reason: "approval_policy_needs_owner_session" },
      );
    }
    const orgId = ctx.scope.orgId;
    const org = await getOrgById(ctx.db, orgId);
    if (!org) throw new OpError("not_found", "no such org");
    const now = ctx.now();
    const done = await ctx.db.transaction(async (tx) => {
      await lockSettingKey(tx, orgId, approvalPolicySetting.key);
      const cur = await resolveApprovalPolicies(tx, orgId, ctx.settings);
      if (cur.locked) {
        throw new OpError(
          "conflict",
          `approval_policy is locked: it is set by ${
            cur.source === "env" ? `the environment (${cur.origin})` : "turntable.toml"
          }; change it there`,
        );
      }
      const entry = nextEnvEntry(cur.value, i.environment, i);
      const next = approvalPolicyMap.safeParse({ ...cur.value, [i.environment]: entry });
      if (!next.success) {
        throw new OpError("invalid_input", next.error.issues.map((x) => x.message).join("; "));
      }
      const loosened = approvalPolicyLoosening(cur.value, next.data);
      let signers: string[] = [];
      if (loosened.length > 0) {
        if (ctx.stepUp?.action !== "set_approval_policy") {
          throw new OpError(
            "forbidden",
            "loosening approval_policy needs a fresh passkey step-up (step_up_required): call session_step_up_challenge",
            { reason: "step_up_required" },
          );
        }
        const counted = await activeIdentities(tx, orgId, await getKeyPolicy(tx, orgId));
        if (counted.length >= 2) {
          const snap = await approvalPolicySnapshot(tx, orgId, i.environment, ctx.settings);
          const digest = approvalPolicyDigest({
            type: APPROVAL_POLICY_STATEMENT_TYPE,
            org: org.slug,
            environment: i.environment,
            generation: snap.generation,
            old: snap.old,
            new: { gated: true, ...entry },
            approver: "",
            expires_at: 1,
            nonce: "",
          });
          const q = await approvalPolicyQuorumState(tx, orgId, digest, now);
          if (q.people.size < q.required) {
            throw new OpError(
              "forbidden",
              `loosening approval_policy in an org with ${counted.length} approvers needs a quorum of them to sign this exact change first (${q.people.size} of ${q.required} so far): approval_policy_challenge, then approve_approval_policy (approver_quorum_required)`,
              {
                reason: "approver_quorum_required",
                approvals: q.people.size,
                required: q.required,
                digest,
              },
            );
          }
          signers = [...q.people].toSorted();
        }
      }
      const store = { kind: "org" as const, id: orgId, orgId };
      const stored = await getStoredSetting(tx, store, approvalPolicySetting.key);
      const written = await putStoredSetting(
        tx,
        store,
        approvalPolicySetting.key,
        next.data,
        ctx.principal.id,
        now,
        { raw: stored?.raw },
      );
      if (!written)
        throw new OpError("conflict", "approval_policy was changed by someone else; try again");
      await recordSettingChange(tx, {
        def: approvalPolicySetting,
        orgId,
        chains: [ctx.scope],
        principalKind: ctx.principal.kind,
        principalId: ctx.principal.id,
        from: cur.value,
        to: next.data,
        source: "db",
      });
      if (loosened.length > 0) {
        await appendAudit(tx, ctx.scope, {
          principalKind: ctx.principal.kind,
          principalId: ctx.principal.id,
          op: "approval_policy.loosened",
          effect: "write",
          outcome: "ok",
          input: { environment: i.environment, loosened, step_up: true, quorum_signers: signers },
        });
      }
      return { value: next.data, source: "db" as const, locked: false };
    });
    const counted = await activeIdentities(ctx.db, orgId, await getKeyPolicy(ctx.db, orgId));
    return viewOf(done, counted.length);
  },
});
