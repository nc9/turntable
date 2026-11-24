// The shipped settings. Migrating a setting onto the registry (#321) means adding it here and
// reading it through the resolver; its environment variable keeps working as the env layer.
import { z } from "zod";
import { UNTRUSTED_RUN_APPROVALS } from "../db/schema";
import {
  approvalPolicyLoosening,
  approvalPolicyMap,
  MAX_REQUIRED_APPROVALS,
} from "../approvals/policy-setting";
import { createSettingsRegistry, defineSetting } from "./define";

/** How many backups `db_backup` keeps when nothing says otherwise. */
export const DEFAULT_BACKUP_KEEP = 10;

export const backupKeepSetting = defineSetting({
  key: "backup_keep",
  scope: "instance",
  type: z.int().min(1).max(10_000),
  default: DEFAULT_BACKUP_KEEP,
  role: "instance_admin",
  // Retention is a safety net, but a value in an agent's context is not an operator's decision.
  // Instance settings are not MCP tools at all; this keeps the rule on the definition.
  mcpEditable: false,
  mcpReason: "instance settings are changed by the instance administrator, never by an agent",
  description: "How many backups to keep under `<data-dir>/backups`, newest first.",
  env: ["TURNTABLE_BACKUP_KEEP"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "backup.keep",
});

/** Hours `create_org_token` waits, for an org that had a token, after its last token ended. */
export const DEFAULT_ORG_TOKEN_REMINT_DELAY_HOURS = 24;
export const MIN_ORG_TOKEN_REMINT_DELAY_HOURS = 1;

export const orgTokenRemintDelaySetting = defineSetting({
  key: "org_remint_delay_hours",
  scope: "instance",
  type: z.int().min(MIN_ORG_TOKEN_REMINT_DELAY_HOURS).max(8760),
  default: DEFAULT_ORG_TOKEN_REMINT_DELAY_HOURS,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it guards against re-minting a tenant's access, so only a person changes it",
  description:
    "Hours `create_org_token` is refused for an org that has had a token, counted from when its last token was revoked or expired (1 to 8760). An org that never had a token is not delayed.",
  warning:
    "Lowering this shortens the window in which a stolen instance token that gets an org's tokens revoked cannot mint itself a new one.",
  env: ["TURNTABLE_ORG_REMINT_DELAY_HOURS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "org_remint_delay_hours",
});

/** Minutes between exports of every org's latest audit anchor, besides one on each checkpoint. */
export const DEFAULT_AUDIT_ANCHOR_EXPORT_MINUTES = 60;

/** A URL with no credentials: a secret in a setting would be stored and shown in the clear. */
const anchorSinkUrl = z.string().refine(
  (v) => {
    if (v === "") return true;
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
      return false;
    }
  },
  { message: "an http(s) URL with no username or password, or an empty string to turn it off" },
);

export const auditAnchorSinkUrlSetting = defineSetting({
  key: "audit_anchor_sink_url",
  scope: "instance",
  type: anchorSinkUrl,
  default: "",
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides where the audit anchors go, so only the instance administrator changes it",
  description:
    "Where each org's latest audit anchor (chain head hash, sequence and time, signed with the org's audit key) is POSTed on every checkpoint and on the interval below. Empty turns the export off. The body is only the org id, sequence, head hash, time and signature. It is signed with `TURNTABLE_AUDIT_WEBHOOK_SECRET` or `TURNTABLE_AUDIT_WEBHOOK_SECRET_FILE`, never with a value kept here. A sink on a private address needs `TURNTABLE_NET_ALLOW_HOSTS`.",
  warning:
    "Clearing or repointing this removes the off-instance copy that detects a database rolled back to an earlier state.",
  env: ["TURNTABLE_AUDIT_ANCHOR_SINK_URL"],
  toml: "audit.anchor_sink_url",
});

export const auditAnchorExportIntervalSetting = defineSetting({
  key: "audit_anchor_export_minutes",
  scope: "instance",
  type: z.int().min(1).max(1440),
  default: DEFAULT_AUDIT_ANCHOR_EXPORT_MINUTES,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it decides how stale the off-instance audit anchor may get, so only a person changes it",
  description:
    "Minutes between exports of each org's latest audit anchor to `audit_anchor_sink_url`, besides the one on every checkpoint (1 to 1440).",
  env: ["TURNTABLE_AUDIT_ANCHOR_EXPORT_MINUTES"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "audit.anchor_export_minutes",
});

export const untrustedRunApprovalSetting = defineSetting({
  key: "untrusted_run_approval",
  scope: "project",
  type: z.enum(UNTRUSTED_RUN_APPROVALS),
  default: "no_agents",
  // Loosening is the instance administrator's, so no org token may do it. `role` is the least
  // role that may tighten it; `instanceAdminOnly` and `strictness` enforce the one-way rule.
  role: "owner",
  instanceAdminOnly: true,
  // An org owner may tighten it (any, then no_agents, then human) but never loosen it, and a
  // reset to the looser default is a loosening: only the instance administrator does that.
  strictness: ["any", "no_agents", "human"],
  // Raising it to `any` lets agents approve: a value in an agent's context is not a human decision.
  mcpEditable: false,
  mcpReason: "it decides whether agents may approve runs, so only a person changes it",
  description:
    "Who may approve a run held for an untrusted author: `human` (an enrolled approver's signed statement only; assumes the org `hardware` key policy, since a key file on a machine where agents run lets an agent sign), `no_agents` (not over MCP, not with an agent token) or `any`.",
  toml: "untrusted_run_approval",
});

/** How long after an org's last approver revocation `bootstrap_approver` stays refused. */
export const DEFAULT_APPROVER_REBOOTSTRAP_DELAY_HOURS = 24;

export const approverRebootstrapDelaySetting = defineSetting({
  key: "approver_rebootstrap_delay_hours",
  // An org setting whose default is the instance-wide value: an org without a stored value, an
  // environment variable or a file entry gets the 24 hours.
  scope: "org",
  type: z.int().min(1).max(8760),
  default: DEFAULT_APPROVER_REBOOTSTRAP_DELAY_HOURS,
  role: "owner",
  // A stolen instance token must not be able to revoke every approver and enrol its own key at
  // once, so only the instance administrator changes the delay, and never through an agent.
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it guards who may enrol an org's release approvers, so only a person changes it",
  description:
    "Hours after an org's last approver was revoked before `bootstrap_approver` may enrol a new first approver (at least 1). An org that never had an approver has no delay.",
  env: ["TURNTABLE_APPROVER_REBOOTSTRAP_DELAY_HOURS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "approver_rebootstrap_delay_hours",
});

/**
 * Per-environment approval policy (#345): how many distinct people an environment needs, whether
 * the author of a run may approve it, and the key-type policy (#152). A map keyed by environment
 * name, because the registry's scopes are instance, org and project and an environment is none
 * of them; one org setting holds them all. The approval engine and `turntable approvals policy`
 * read and write it through the resolver, so a value in the environment or `turntable.toml` locks
 * it for both.
 */
export const approvalPolicySetting = defineSetting({
  key: "approval_policy",
  scope: "org",
  type: approvalPolicyMap,
  default: {},
  // Lowering it removes the two-person rule, so no org token sets it, whatever its role.
  role: "owner",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides how many people must approve a release, so only a person changes it",
  description: `Approval policy per environment, a map from environment name to \`required\` (distinct approvers, 1 to ${MAX_REQUIRED_APPROVALS}), \`allow_author_approval\` (default false) and \`key_policy\` (\`any\` or \`hardware\`, default \`any\`). An environment with no entry is \`production\` and \`release\` at two approvers and every other one ungated.`,
  warning:
    "Lowering this weakens human approval: one approver, the author approving their own run, or any key instead of a hardware key. A solo setup needs it; a team does not.",
  loosens: approvalPolicyLoosening,
  // The same map in the environment applies to every org on the instance.
  env: ["TURNTABLE_APPROVAL_POLICY"],
  envParse: (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
  toml: "approval_policy",
});

/** The scheduling classes of a project: `yield` work gives way to `normal` work (see the scheduler). */
export const SCHEDULING_CLASSES = ["normal", "yield"] as const;
export type SchedulingClass = (typeof SCHEDULING_CLASSES)[number];

export const schedulingClassSetting = defineSetting({
  key: "scheduling_class",
  scope: "project",
  type: z.enum(SCHEDULING_CLASSES),
  default: "normal",
  // Instance operator only: a class is a decision about whose work the shared fleet serves first.
  role: "owner",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it decides whose work the shared fleet serves first, so only the instance administrator changes it",
  description:
    "How the project's jobs share the fleet: `normal`, or `yield` (a yield job is claimed only while no normal job is waiting, and is preempted and requeued when a normal job waits at a cap).",
  toml: "scheduling_class",
});

/**
 * Anti-thrash for `yield` projects (#355): after this many preemptions of one job inside the
 * window, the job is no longer preempted until it finishes (the window runs out first, or it ends).
 * 0, the default, means no limit: normal work waits only for a teardown.
 */
export const DEFAULT_PREEMPT_MAX_PER_JOB = 0;
export const DEFAULT_PREEMPT_WINDOW_MINUTES = 60;

export const preemptMaxPerJobSetting = defineSetting({
  key: "preempt_max_per_job",
  scope: "instance",
  type: z.int().min(0).max(1000),
  default: DEFAULT_PREEMPT_MAX_PER_JOB,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides how much a yield job may be disturbed, so only a person changes it",
  description:
    "How many times one `yield` job may be preempted inside `preempt_window_minutes` (0 to 1000). 0 means no limit and is the default. With 1 or more, the job is not preempted again after that until it finishes: normal work waits for it and the job runs to the end. Trade-off: the cap bounds wasted yield minutes but can make normal work wait for a capped yield job, so on a shared hosted instance enable it only with the affected tenants' agreement.",
  env: ["TURNTABLE_PREEMPT_MAX_PER_JOB"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "scheduler.preempt_max_per_job",
});

export const preemptWindowMinutesSetting = defineSetting({
  key: "preempt_window_minutes",
  scope: "instance",
  type: z.int().min(1).max(10_080),
  default: DEFAULT_PREEMPT_WINDOW_MINUTES,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides how much a yield job may be disturbed, so only a person changes it",
  description:
    "The window, in minutes, over which `preempt_max_per_job` counts the preemptions of one job (1 to 10080). Used only when `preempt_max_per_job` is 1 or more.",
  env: ["TURNTABLE_PREEMPT_WINDOW_MINUTES"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "scheduler.preempt_window_minutes",
});

/** Seconds a SIGTERM waits for running attempts after it starts a drain (#446). */
export const DEFAULT_DRAIN_TIMEOUT_SECONDS = 600;

export const drainTimeoutSecondsSetting = defineSetting({
  key: "drain_timeout_seconds",
  scope: "instance",
  type: z.int().min(0).max(3600),
  default: DEFAULT_DRAIN_TIMEOUT_SECONDS,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it decides how long a shutdown waits for tenants' running jobs, so only a person changes it",
  description:
    "Seconds a SIGTERM waits for running attempts to finish before the server exits (0 to 3600). The server stops starting new attempts at once; attempts still running at the timeout are left for the next boot's reconcile.",
  env: ["TURNTABLE_DRAIN_TIMEOUT_SECONDS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "scheduler.drain_timeout_seconds",
});

/** The shipped registry. */
export const settingsRegistry = createSettingsRegistry([
  backupKeepSetting,
  approverRebootstrapDelaySetting,
  orgTokenRemintDelaySetting,
  auditAnchorSinkUrlSetting,
  auditAnchorExportIntervalSetting,
  untrustedRunApprovalSetting,
  approvalPolicySetting,
  schedulingClassSetting,
  preemptMaxPerJobSetting,
  preemptWindowMinutesSetting,
  drainTimeoutSecondsSetting,
]);
