// The shipped settings. Migrating a setting onto the registry (#321) means adding it here and
// reading it through the resolver; its environment variable keeps working as the env layer.
import { z } from "zod";
import { UNTRUSTED_RUN_APPROVALS } from "../db/schema";
import {
  approvalPolicyLoosening,
  approvalPolicyMap,
  MAX_REQUIRED_APPROVALS,
} from "../approvals/policy-setting";
import { refuseLabelMap } from "../scheduler/sandbox-size";
import { FULL_HISTORY_FACTOR } from "../run/git-fetch";
import { createSettingsRegistry, defineSetting, type SettingDef } from "./define";

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

/** Most log bytes one `job_log` grep call walks, and the registry default for it. */
export const DEFAULT_JOB_LOG_GREP_SCAN_BYTES = 32 * 1024 * 1024;

export const jobLogGrepScanBytesSetting = defineSetting({
  key: "job_log_grep_scan_bytes",
  scope: "instance",
  type: z.int().min(65_536).max(1_073_741_824),
  default: DEFAULT_JOB_LOG_GREP_SCAN_BYTES,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it bounds the work one read call may do, so only the instance administrator changes it",
  description:
    "Most log bytes one `job_log` grep call walks from its offset (65536 to 1073741824). A log past it stops with `stopped: scan_budget` and is paged on with `next_offset`. `max_bytes` and `max_matches` cap only the output.",
  env: ["TURNTABLE_JOB_LOG_GREP_SCAN_BYTES"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "job_log.grep_scan_bytes",
});

export const DEFAULT_JOB_LOG_GREP_DEADLINE_MS = 2000;

export const jobLogGrepDeadlineSetting = defineSetting({
  key: "job_log_grep_deadline_ms",
  scope: "instance",
  type: z.int().min(200).max(10_000),
  default: DEFAULT_JOB_LOG_GREP_DEADLINE_MS,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it bounds the server time one read call may take, so only the instance administrator changes it",
  description:
    "Wall-clock milliseconds one `job_log` grep call may run (200 to 10000). When it runs out the call returns `stopped: deadline` with a `next_offset` at the last line it finished, and the caller pages on. Separate from `job_log_grep_scan_bytes`.",
  env: ["TURNTABLE_JOB_LOG_GREP_DEADLINE_MS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "job_log.grep_deadline_ms",
});

/** Which agent principals may start a `workflow_dispatch` run (`run_dispatch_agents`, per project). */
export const RUN_DISPATCH_AGENTS = ["none", "unprivileged", "any"] as const;
export type RunDispatchAgents = (typeof RUN_DISPATCH_AGENTS)[number];

export const runDispatchAgentsSetting = defineSetting({
  key: "run_dispatch_agents",
  scope: "project",
  type: z.enum(RUN_DISPATCH_AGENTS),
  default: "unprivileged",
  // Loosening is the instance administrator's, as for `untrusted_run_approval`: an org owner may
  // tighten it (unprivileged, then none) but never loosen it.
  role: "owner",
  instanceAdminOnly: true,
  strictness: ["any", "unprivileged", "none"],
  trust: "tighten_only",
  // A protected or release run can hold deploy credentials and an agent reads untrusted text, so
  // a value in an agent's context must not widen what agents may dispatch.
  mcpEditable: false,
  mcpReason:
    "it decides whether agents may dispatch protected or release runs, so only a person changes it",
  description:
    "Which agent tokens may start a `workflow_dispatch` run with `run_dispatch`: `none` (never), `unprivileged` (only a run below the protected class: not the default branch, a protected ref or a release tag) or `any` (a release run still waits for its human approval). A person's token is not affected.",
  toml: "run_dispatch_agents",
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
  trust: "tighten_only",
  // Raising it to `any` lets agents approve: a value in an agent's context is not a human decision.
  mcpEditable: false,
  mcpReason: "it decides whether agents may approve runs, so only a person changes it",
  description:
    "Who may approve a run held for an untrusted author: `human` (an enrolled approver's signed statement only; assumes the org `hardware` key policy, since a key file on a machine where agents run lets an agent sign), `no_agents` (not over MCP, not with an agent token) or `any`.",
  toml: "untrusted_run_approval",
});

/** The values of `checks_mode`; the same three the `projects.checks_mode` column has always held. */
export const CHECKS_MODE_VALUES = ["off", "shadow", "live"] as const;

export const checksModeSetting = defineSetting({
  key: "checks_mode",
  scope: "project",
  type: z.enum(CHECKS_MODE_VALUES),
  // The column's own default, so a project nobody set keeps the mode it has today.
  default: "off",
  // Owner or admin: `live` posts real `turntable / <job>` checks to the repo, which can gate merges.
  role: "admin",
  mcpEditable: true,
  description:
    "What this project reports to GitHub as check runs: `off` (nothing), `shadow` (neutral `shadow / <job>` checks that never gate a merge) or `live` (real `turntable / <job>` conclusions). Stored in the project's `checks_mode` column, which the checks reporter reads; a value from the environment or `turntable.toml` locks it.",
  warning: "`live` posts checks that can block merges when a branch rule requires them.",
  toml: "checks_mode",
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

/** Who may create an org for themselves from the web (`self_serve_orgs`). */
export const SELF_SERVE_ORGS = ["off", "allowlist", "any"] as const;
export type SelfServeOrgs = (typeof SELF_SERVE_ORGS)[number];
export const MAX_SELF_SERVE_ORG_LOGINS = 200;

export const selfServeOrgsSetting = defineSetting({
  key: "self_serve_orgs",
  scope: "instance",
  type: z.enum(SELF_SERVE_ORGS),
  default: "allowlist",
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides who may create orgs on this instance, so only a person changes it",
  description:
    "Who may create an org for themselves after signing in with GitHub: `off` (nobody; only the instance administrator creates orgs), `allowlist` (only the GitHub logins in `self_serve_org_logins`) or `any` (any GitHub account that signs in).",
  warning:
    "`any` lets every GitHub account that can reach this instance create an org and use its sandbox quota.",
  env: ["TURNTABLE_SELF_SERVE_ORGS"],
  toml: "auth.self_serve_orgs",
});

export const selfServeOrgLoginsSetting = defineSetting({
  key: "self_serve_org_logins",
  scope: "instance",
  type: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/)).max(MAX_SELF_SERVE_ORG_LOGINS),
  default: [] as string[],
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason: "it decides who may create orgs on this instance, so only a person changes it",
  description:
    "GitHub logins (at most 200, compared without regard to case) that may create an org when `self_serve_orgs` is `allowlist`. In the environment, a comma-separated list.",
  env: ["TURNTABLE_SELF_SERVE_ORG_LOGINS"],
  envParse: (raw) =>
    raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== ""),
  toml: "auth.self_serve_org_logins",
});

/** Web sessions (#430): how long one may sit idle, and how long it lives at most. */
export const DEFAULT_SESSION_IDLE_HOURS = 12;
export const DEFAULT_SESSION_ABSOLUTE_DAYS = 7;

export const sessionIdleHoursSetting = defineSetting({
  key: "session_idle_hours",
  scope: "instance",
  type: z.int().min(1).max(168),
  default: DEFAULT_SESSION_IDLE_HOURS,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it decides how long a stolen browser session stays usable, so only a person changes it",
  description:
    "Hours a web session may sit unused before it is signed out (1 to 168). Each request from the session restarts the clock.",
  warning: "Raising this lengthens the time a session left open in a browser stays usable.",
  env: ["TURNTABLE_SESSION_IDLE_HOURS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "auth.session_idle_hours",
});

export const sessionAbsoluteDaysSetting = defineSetting({
  key: "session_absolute_days",
  scope: "instance",
  type: z.int().min(1).max(90),
  default: DEFAULT_SESSION_ABSOLUTE_DAYS,
  role: "instance_admin",
  instanceAdminOnly: true,
  mcpEditable: false,
  mcpReason:
    "it decides how long a stolen browser session stays usable, so only a person changes it",
  description:
    "Days a web session lives at most, however active it is (1 to 90). After that the person signs in with GitHub again.",
  warning: "Raising this lengthens the time a stolen session can be used.",
  env: ["TURNTABLE_SESSION_ABSOLUTE_DAYS"],
  envParse: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw),
  toml: "auth.session_absolute_days",
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

/**
 * Per-org and per-project `runs-on` label maps (#492). A map from a label to the NAME of a size
 * class the instance operator defined; a tenant never defines a
 * class, so it can reach only sizes the operator chose, still clamped by the operator's ceilings.
 * Project beats org beats the instance map; an untrusted run ignores all of them. Two keys because
 * a setting key is unique across scopes. No environment variable: the layers are the file and the
 * database.
 */
const runnerLabelMap = z
  .record(z.string().min(1).max(100), z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
  .refine((m) => Object.keys(m).length <= 64, {
    message: "at most 64 labels",
  });
const runnerLabelsCommon = {
  type: runnerLabelMap,
  default: {} as Record<string, string>,
  role: "release_operator" as const,
  refuse: (m: Record<string, string>, ctx?: { orgSlug?: string }) => refuseLabelMap(m, ctx),
  // A bigger class costs the instance more: a value in an agent's context is not a human decision.
  mcpEditable: false,
  mcpReason: "it chooses how large a tenant's sandboxes are, so only a person changes it",
};

export const orgRunnerLabelsSetting = defineSetting({
  ...runnerLabelsCommon,
  key: "runner_labels",
  scope: "org",
  description:
    "Maps a `runs-on` label to the name of a sandbox size class the instance operator defined, for every project of the org. Overrides the instance label map; a project's `project_runner_labels` overrides this. A class the operator has not defined, or has not made available to the org (`tenantSelectable`, `orgs`), is refused, and the operator's ceilings still apply. An untrusted pull request ignores it.",
  toml: "runner_labels",
});

export const projectRunnerLabelsSetting = defineSetting({
  ...runnerLabelsCommon,
  key: "project_runner_labels",
  scope: "project",
  description:
    "Maps a `runs-on` label to the name of a sandbox size class the instance operator defined, for this project. Overrides the org's `runner_labels` and the instance label map. A class the operator has not defined, or has not made available to the org (`tenantSelectable`, `orgs`), is refused, and the operator's ceilings still apply. An untrusted pull request ignores it.",
  toml: "runner_labels",
});

/** The shipped registry. */
/**
 * Checkout size budgets (#677): what a checkout of a repository may fetch, unpack and pack. The
 * instance value is the default for every project (the environment variables that always set it
 * still lock it), a project may override it up to the instance ceiling, and a full-history
 * delivery multiplies all three by `FULL_HISTORY_FACTOR` (4). Raising a budget raises what a
 * hostile repository may make the checkout child use, so every one is instance-administrator only
 * and never an MCP edit; the guards that are not budgets (per-object, tree, entry, delta chain,
 * deadline, symlink and name checks) do not change.
 */
type BudgetSpec = {
  name: "pack" | "unpacked" | "tarball";
  /** Default, ceiling default and top, in MiB. The top is the environment variable's own bound. */
  def: number;
  ceiling: number;
  max: number;
  what: string;
  env: string;
};

const CHECKOUT_BUDGETS: readonly BudgetSpec[] = [
  {
    name: "pack",
    def: 128,
    ceiling: 1024,
    max: 4096,
    what: "the packfile the server sends",
    env: "TURNTABLE_CHECKOUT_MAX_PACK_MIB",
  },
  {
    name: "unpacked",
    def: 512,
    ceiling: 4096,
    max: 16384,
    what: "all object data once the pack is unpacked, deltas included, and the files written from it",
    env: "TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB",
  },
  {
    name: "tarball",
    def: 256,
    ceiling: 1024,
    max: 4096,
    what: "the gzip tarball handed to the sandbox",
    env: "TURNTABLE_CHECKOUT_MAX_TARBALL_MIB",
  },
];

const mibEnv = (raw: string): unknown => (/^\d+$/.test(raw) ? Number(raw) : raw);

function checkoutBudgetSettings(b: BudgetSpec): SettingDef[] {
  const inst = `checkout_max_${b.name}_mib`;
  const ceil = `checkout_ceiling_${b.name}_mib`;
  const why =
    "raising it raises what one repository may make the checkout use, so a person does it";
  return [
    defineSetting({
      key: inst,
      scope: "instance",
      type: z.int().min(1).max(b.max),
      default: b.def,
      role: "instance_admin",
      instanceAdminOnly: true,
      mcpEditable: false,
      mcpReason: why,
      description: `Most MiB of ${b.what} that a checkout of a shallow tree may take, for every project (1 to ${b.max}). A full-history checkout (\`fetch-depth: 0\`) gets ${FULL_HISTORY_FACTOR} times this. A project overrides it with \`project_${inst}\`, up to \`${ceil}\`. A checkout over it ends \`infra_error\` with kind \`fetch_limit\`. Memory: the checkout child holds unpacked data in memory, so raise \`TURNTABLE_CHECKOUT_MAX_MEMORY_MIB\` with it.`,
      warning:
        "Raising this lets a hostile repository make the checkout child use more disk and memory.",
      env: [b.env],
      envParse: mibEnv,
      toml: `checkout.max_${b.name}_mib`,
    }),
    defineSetting({
      key: ceil,
      scope: "instance",
      type: z.int().min(1).max(b.max),
      default: Math.min(b.ceiling, b.max),
      role: "instance_admin",
      instanceAdminOnly: true,
      mcpEditable: false,
      mcpReason: why,
      description: `The most MiB a project's \`project_${inst}\` may be set to (1 to ${b.max}). A higher value is refused, and a stored one above it is clamped to it. It does not limit the full-history multiplier.`,
      env: [`TURNTABLE_CHECKOUT_CEILING_${b.name.toUpperCase()}_MIB`],
      envParse: mibEnv,
      toml: `checkout.ceiling_${b.name}_mib`,
    }),
    defineSetting({
      key: `project_${inst}`,
      scope: "project",
      type: z.int().min(0).max(b.max),
      default: 0,
      role: "admin",
      instanceAdminOnly: true,
      ceiling: ceil,
      mcpEditable: false,
      mcpReason: why,
      description: `Most MiB of ${b.what} that a checkout of this project's shallow tree may take (0 uses \`${inst}\`, else up to \`${ceil}\`). A full-history checkout gets ${FULL_HISTORY_FACTOR} times it. Raise it for one large repository without raising the limit for every project.`,
      warning:
        "Raising this lets this project's repository make the checkout child use more disk and memory.",
      toml: `checkout_max_${b.name}_mib`,
    }),
  ];
}

export const checkoutBudgetSettingList = CHECKOUT_BUDGETS.flatMap(checkoutBudgetSettings);

export const settingsRegistry = createSettingsRegistry([
  backupKeepSetting,
  jobLogGrepScanBytesSetting,
  jobLogGrepDeadlineSetting,
  approverRebootstrapDelaySetting,
  orgTokenRemintDelaySetting,
  auditAnchorSinkUrlSetting,
  auditAnchorExportIntervalSetting,
  untrustedRunApprovalSetting,
  checksModeSetting,
  runDispatchAgentsSetting,
  approvalPolicySetting,
  schedulingClassSetting,
  preemptMaxPerJobSetting,
  preemptWindowMinutesSetting,
  drainTimeoutSecondsSetting,
  sessionIdleHoursSetting,
  sessionAbsoluteDaysSetting,
  selfServeOrgsSetting,
  selfServeOrgLoginsSetting,
  orgRunnerLabelsSetting,
  projectRunnerLabelsSetting,
  ...checkoutBudgetSettingList,
]);
