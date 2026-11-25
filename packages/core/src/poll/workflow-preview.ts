// The dry run behind `preview_workflows`: what Turntable would do with each job of one workflow
// file, decided by the real planner and the real refusal rules, never by running anything. Pure:
// text in, verdicts out. The output carries ids, names and fixed words only, never file content.
import { planWorkflow, type PlannedJob, type WorkflowEvent } from "@turntable/act-runner";
import { parse } from "yaml";
import { refusalFor } from "../scheduler/sandbox-size";

/** Events Turntable ingests today (a tag push is a `push`). `schedule` is not ingested yet. */
export const INGESTED_EVENTS: readonly string[] = [
  "push",
  "pull_request",
  "merge_group",
  "workflow_dispatch",
];

export type RefusalKind =
  | "other_os"
  | "arm"
  | "docker"
  | "reusable"
  | "matrix_expression"
  | "environment_expression"
  | "expression"
  | "plan_error"
  | "other";

const GATE = "add `if: vars.TURNTABLE_CI != 'true'` to the job to skip it on Turntable";

/** The fix for each refusal kind. Fixed text: nothing from the workflow is ever put in it. */
export const FIX_BY_KIND: Readonly<Record<RefusalKind, string>> = {
  other_os: GATE,
  arm: GATE,
  docker: `${GATE}, or ask the instance operator for a Docker-capable size class`,
  reusable: `${GATE}, or inline the called workflow's jobs`,
  matrix_expression: `${GATE}, or write the matrix out as a literal list`,
  environment_expression: `${GATE}, or name the environment literally`,
  expression: `${GATE}, or simplify the expression`,
  plan_error: "fix the workflow so it parses and plans, then preview again",
  other: GATE,
};

/** Which refusal a planner `unsupported` text is. Keyed on the planner's own fixed phrases. */
export function refusalKind(why: string): RefusalKind {
  if (/runner \(`/.test(why) && /macOS|Windows/.test(why)) return "other_os";
  if (/arm64 runner/.test(why)) return "arm";
  if (/reusable workflow/.test(why)) return "reusable";
  if (/matrix built from an expression/.test(why)) return "matrix_expression";
  if (/^unsupported: environment:|^environment:/.test(why)) return "environment_expression";
  if (/docker|services:|container:/i.test(why)) return "docker";
  if (/if:|continue-on-error expression/.test(why)) return "expression";
  return "other";
}

export type PreviewJob = {
  job_id: string;
  name: string | null;
  verdict: "run" | "skip" | "fail";
  reason?: string;
  fix?: string;
};

export type WorkflowPreview = {
  name: string | null;
  triggers: string[];
  /** True when a trigger Turntable ingests is present. */
  hasIngestedTrigger: boolean;
  jobs: PreviewJob[];
};

const clip = (s: string, n: number): string => s.replaceAll(/[\r\n]+/g, " ").slice(0, n);

function triggerNames(on: unknown): string[] {
  const names =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.filter((x): x is string => typeof x === "string")
        : on !== null && typeof on === "object"
          ? Object.keys(on)
          : [];
  return names.slice(0, 20).map((n) => clip(n, 64));
}

export function previewWorkflow(
  yaml: string,
  o: { defaultBranch: string; vars: Record<string, string> },
): WorkflowPreview | undefined {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch {
    return undefined;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const root = doc as { name?: unknown; on?: unknown; true?: unknown; jobs?: unknown };
  if (root.jobs === null || typeof root.jobs !== "object") return undefined;
  const triggers = triggerNames(root.on ?? root.true);
  const hasIngestedTrigger = triggers.some((t) => INGESTED_EVENTS.includes(t));
  const base = {
    name: typeof root.name === "string" ? clip(root.name, 200) : null,
    triggers,
    hasIngestedTrigger,
  };
  const ids = Object.keys(root.jobs as object);
  const jobNames = new Map<string, string | null>(
    ids.map((id) => {
      const j = (root.jobs as Record<string, { name?: unknown } | null>)[id];
      return [id, typeof j?.name === "string" ? clip(j.name, 200) : null];
    }),
  );
  const row = (
    id: string,
    rest: Partial<PreviewJob> & Pick<PreviewJob, "verdict">,
  ): PreviewJob => ({
    job_id: clip(id, 100),
    name: jobNames.get(id) ?? null,
    ...rest,
  });
  if (!hasIngestedTrigger) {
    return {
      ...base,
      jobs: ids.map((id) =>
        row(id, { verdict: "skip", reason: "this workflow has no trigger Turntable ingests" }),
      ),
    };
  }
  // Plan with the event the workflow would most likely get on the default branch.
  const name =
    ["push", "pull_request", "merge_group", "workflow_dispatch"].find((e) =>
      triggers.includes(e),
    ) ?? "push";
  const event: WorkflowEvent = {
    name,
    ref: name === "pull_request" ? "refs/pull/1/head" : `refs/heads/${o.defaultBranch}`,
    ...(name === "pull_request" || name === "merge_group" ? { baseRef: o.defaultBranch } : {}),
  };
  let nodes: PlannedJob[];
  try {
    nodes = planWorkflow(yaml, event, {
      // Local composite actions are not fetched: a docker step inside one is not seen here.
      readFile: () => undefined,
      vars: o.vars,
      github: { sha: "0".repeat(40), actor: "preview" },
    }).jobs;
  } catch {
    // The planner's message can quote the file; the preview says only that it cannot plan.
    return {
      ...base,
      jobs: ids.map((id) =>
        row(id, {
          verdict: "fail",
          reason: "the planner cannot read this workflow",
          fix: FIX_BY_KIND.plan_error,
        }),
      ),
    };
  }
  const jobs = ids.map((id): PreviewJob => {
    const legs = nodes.filter((n) => n.id === id);
    for (const n of legs) {
      // The provider's arch is unknown here: assume amd64 only, as the default providers are.
      const why =
        refusalFor(n, ["amd64"]) ??
        (n.needsDocker ? `unsupported: ${clip(n.needsDocker, 80)}` : undefined);
      if (why) {
        return row(id, {
          verdict: "fail",
          reason: clip(why, 300),
          fix: FIX_BY_KIND[refusalKind(why)],
        });
      }
    }
    if (legs.length > 0 && legs.every((n) => n.staticSkip)) {
      return row(id, {
        verdict: "skip",
        reason: "its `if:` condition is false on Turntable before the job starts",
      });
    }
    return row(id, { verdict: "run" });
  });
  return { ...base, jobs };
}
