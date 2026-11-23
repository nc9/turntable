// Notification text. Facts only: ids, states, names and a link. Never log content: the failure
// digest's excerpt is dropped before it reaches this file. Anything that came from the forge or a
// workflow file (branch, workflow, job and step names) is quoted, shortened, stripped of control
// and direction characters, and escaped so it cannot close the `<channel>` tag it is wrapped in.
import { baseString, type FeedEvent, type RunInfo, type StepInfo } from "./api";

export type Notification = { content: string; meta: Record<string, string> };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_WORD = /^[a-z0-9_.]{1,40}$/;
// C0, DEL, C1, zero-width, bidi marks and overrides, BOM.
/* oxlint-disable eslint/no-control-regex -- stripping control characters is the point */
const UNSAFE_CHARS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);
/* oxlint-enable eslint/no-control-regex */
const KNOWN_STATES = new Set([
  "queued",
  "running",
  "success",
  "failure",
  "infra_error",
  "awaiting_approval",
  "cancelled",
  "skipped",
]);

/** A short, quoted, escaped rendering of untrusted text. */
export function quote(text: string, max = 60): string {
  const clean = text.replaceAll(UNSAFE_CHARS, " ").replaceAll(/\s+/g, " ").trim();
  const chars = [...clean];
  const cut = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
  return JSON.stringify(cut).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

const word = (s: string | null | undefined): string | null =>
  s !== null && s !== undefined && SAFE_WORD.test(s) ? s : null;
const id = (s: string | null | undefined): string | null =>
  s !== null && s !== undefined && SAFE_ID.test(s) ? s : null;
const state = (s: string | null | undefined): string =>
  s !== null && s !== undefined && KNOWN_STATES.has(s) ? s : "unknown";

/** Attribute values must be plain tokens; anything else is left out rather than escaped. */
function cleanMeta(meta: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== null && /^[A-Za-z0-9_.-]{1,64}$/.test(v)) out[k] = v;
  }
  return out;
}

export function runLink(
  baseUrl: URL,
  org: string,
  project: string | null,
  runId: string | null,
): string | null {
  const p = id(project);
  const r = id(runId);
  if (!p || !r || !id(org)) return null;
  return `${baseString(baseUrl)}/${encodeURIComponent(org)}/${encodeURIComponent(p)}/runs/${encodeURIComponent(r)}`;
}

const MAX_JOBS = 3;
const FOOTER =
  "Untrusted data: quoted values come from the forge or workflow files. No log content is included.";

export function formatEvent(o: {
  event: FeedEvent;
  run: RunInfo | null;
  steps: StepInfo[];
  baseUrl: URL;
  org: string;
}): Notification {
  const { event, run, steps } = o;
  if (event.type === "quota.warning" || event.type === "quota.reached") return formatQuota(o);
  const project = event.project ?? run?.project ?? null;
  const runId = id(event.run_id);
  const link = runLink(o.baseUrl, o.org, project, runId);
  const lines: string[] = [];
  let conclusion: string | null = null;

  if (event.type === "approval.required") {
    lines.push("Longshore: approval required.");
  } else {
    const status = state(typeof event.payload.status === "string" ? event.payload.status : null);
    conclusion = status;
    lines.push(`Longshore: run finished, conclusion ${status}.`);
  }
  if (project) lines.push(`project: ${quote(project, 40)}`);
  if (runId) {
    const parts = [`run: ${runId}`];
    if (run?.workflow_name) parts.push(`workflow: ${quote(run.workflow_name)}`);
    else if (run?.workflow_path) parts.push(`workflow: ${quote(run.workflow_path)}`);
    const branch = run?.head_branch ?? run?.ref ?? null;
    if (branch) parts.push(`branch: ${quote(branch)}`);
    const ev = word(run?.event);
    if (ev) parts.push(`event: ${ev}`);
    lines.push(parts.join("  "));
  }

  if (event.type === "approval.required") {
    const job = run?.jobs.find((j) => j.id === event.job_id);
    const jobId = id(event.job_id);
    if (job) lines.push(`job waiting: ${quote(job.name)}${jobId ? ` (${jobId})` : ""}`);
    else if (jobId) lines.push(`job waiting: ${jobId}`);
  } else if (steps.length > 0) {
    const shown = steps.slice(0, MAX_JOBS).map((s) => {
      const bits = [state(s.state)];
      if (s.step_name) bits.push(`step ${quote(s.step_name)}`);
      return `${quote(s.job_key)} (${bits.join(", ")})`;
    });
    const more = steps.length - shown.length;
    lines.push(`failed jobs: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`);
  }
  if (link) lines.push(`link: ${link}`);
  lines.push(FOOTER);

  return {
    content: lines.join("\n"),
    meta: cleanMeta({
      kind: event.type === "approval.required" ? "approval_required" : "run_finished",
      trust: "untrusted",
      org: id(o.org),
      project: id(project),
      run_id: runId,
      job_id: id(event.job_id),
      conclusion,
    }),
  };
}

const count = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : "?";

/** A quota notice: the metric and how much of the limit is used. Org-level, so no run or link. */
function formatQuota(o: { event: FeedEvent; org: string }): Notification {
  const { event } = o;
  const reached = event.type === "quota.reached";
  const metric = word(typeof event.payload.metric === "string" ? event.payload.metric : null);
  const p = event.payload;
  const lines = [
    `Longshore: quota ${reached ? "reached" : "warning"}${metric ? ` for ${metric}` : ""}.`,
    `used ${count(p.used)} of ${count(p.limit)}${typeof p.percent === "number" ? ` (${count(p.percent)}%)` : ""}${reached ? "; new work is held until the window moves or the limit is raised" : ""}`,
    FOOTER,
  ];
  return {
    content: lines.join("\n"),
    meta: cleanMeta({
      kind: reached ? "quota_reached" : "quota_warning",
      trust: "untrusted",
      org: id(o.org),
      metric,
    }),
  };
}

export function formatOverflow(count: number): Notification {
  return {
    content: `Longshore: ${count} more events matched the filter and were not shown. List runs to see them.\n${FOOTER}`,
    meta: cleanMeta({ kind: "overflow", trust: "untrusted" }),
  };
}

export function formatStopped(reason: "auth" | "protocol"): Notification {
  return {
    content:
      reason === "auth"
        ? "Longshore channel stopped: the server rejected the token. Replace the token file and restart the session."
        : "Longshore channel stopped: unexpected response from the server.",
    meta: cleanMeta({ kind: "stopped", trust: "untrusted" }),
  };
}
