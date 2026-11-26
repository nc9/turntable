// Which jobs of a workflow need more than the one commit the control plane delivers by default:
// a checkout step that asks for `fetch-depth: 0` (or any depth above 1) or `fetch-tags: true`.
// The delivery for such a job is the full history, the tags and the default branch.
import { parse } from "yaml";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const isCheckout = (uses: unknown): boolean =>
  typeof uses === "string" && /^actions\/checkout(@|$)/i.test(uses.trim());

/**
 * Whether one checkout step's `with` needs history past one commit. A value that is an expression
 * (`${{ ... }}`) cannot be read before the job runs, so it counts as needing it: a job that wants
 * less still gets a correct repository, only a bigger one.
 */
export function stepNeedsFullHistory(w: unknown): boolean {
  if (!isObj(w)) return false;
  const depth = w["fetch-depth"];
  if (depth !== undefined && depth !== null) {
    const text = String(depth).trim();
    if (text.includes("${{")) return true;
    if (!/^\d+$/.test(text) || Number(text) !== 1) return true;
  }
  const tags = w["fetch-tags"];
  if (tags !== undefined && tags !== null) {
    const text = String(tags).trim().toLowerCase();
    if (text.includes("${{") || text === "true") return true;
  }
  return false;
}

/** Per job id: true when a checkout step of the job needs the full history. */
export function workflowFullHistoryJobs(yaml: string): Record<string, boolean> {
  const doc: unknown = parse(yaml, { merge: true });
  const jobs = isObj(doc) && isObj(doc.jobs) ? doc.jobs : {};
  const out: Record<string, boolean> = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObj(job) || !Array.isArray(job.steps)) continue;
    out[id] = job.steps.some((s) => isObj(s) && isCheckout(s.uses) && stepNeedsFullHistory(s.with));
  }
  return out;
}

export type SubmoduleMode = "true" | "recursive";

/**
 * What one checkout step's `submodules` input asks for: nothing (`false`, the default), the
 * gitlinks (`true`) or their own too (`recursive`). An expression cannot be read before the job
 * runs, so it counts as `recursive`: the job gets a bigger repository, never a wrong one.
 */
export function stepSubmodules(w: unknown): SubmoduleMode | undefined {
  if (!isObj(w)) return undefined;
  const v = w["submodules"];
  if (v === undefined || v === null) return undefined;
  const text = String(v).trim().toLowerCase();
  if (text.includes("${{")) return "recursive";
  if (text === "true") return "true";
  if (text === "recursive") return "recursive";
  return undefined;
}

/** Per job id: the submodule delivery its checkout steps ask for (the widest), if any. */
export function workflowSubmodulesJobs(yaml: string): Record<string, SubmoduleMode | undefined> {
  const doc: unknown = parse(yaml, { merge: true });
  const jobs = isObj(doc) && isObj(doc.jobs) ? doc.jobs : {};
  const out: Record<string, SubmoduleMode | undefined> = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObj(job) || !Array.isArray(job.steps)) continue;
    let mode: SubmoduleMode | undefined;
    for (const s of job.steps) {
      if (!isObj(s) || !isCheckout(s.uses)) continue;
      const m = stepSubmodules(s.with);
      if (m === "recursive" || (m === "true" && mode === undefined)) mode = m;
    }
    out[id] = mode;
  }
  return out;
}
