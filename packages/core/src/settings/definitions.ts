// The shipped settings. Migrating a setting onto the registry (#321) means adding it here and
// reading it through the resolver; its environment variable keeps working as the env layer.
import { z } from "zod";
import { UNTRUSTED_RUN_APPROVALS } from "../db/schema";
import {
  approvalPolicyLoosening,
  approvalPolicyMap,
  MAX_REQUIRED_APPROVALS,
} from "../approvals/policy-setting";
import { HUMAN_MODE_UNAVAILABLE } from "../ops/approval-policy";
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

export const untrustedRunApprovalSetting = defineSetting({
  key: "untrusted_run_approval",
  scope: "project",
  type: z.enum(UNTRUSTED_RUN_APPROVALS),
  default: "no_agents",
  // Today's rule: every change is the instance administrator's, so no org token may set it.
  // `role` is the ladder's top; `instanceAdminOnly` is what enforces it.
  role: "owner",
  instanceAdminOnly: true,
  // Raising it to `any` lets agents approve: a value in an agent's context is not a human decision.
  mcpEditable: false,
  mcpReason: "it decides whether agents may approve runs, so only a person changes it",
  // `human` is in the type so a stored value still fails closed, but it cannot be chosen yet.
  refuse: (v) => (v === "human" ? HUMAN_MODE_UNAVAILABLE : undefined),
  description:
    "Who may approve a run held for an untrusted author: `human` (an enrolled approver's signature only; not selectable yet), `no_agents` (not over MCP, not with an agent token) or `any`.",
  toml: "untrusted_run_approval",
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

/** The shipped registry. */
export const settingsRegistry = createSettingsRegistry([
  backupKeepSetting,
  untrustedRunApprovalSetting,
  approvalPolicySetting,
  schedulingClassSetting,
]);
