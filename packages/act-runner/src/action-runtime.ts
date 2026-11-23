import { PlanError } from "./plan";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The only non-composite runtimes Turntable runs. Anything else is refused. */
export const NODE_RUNTIMES: readonly string[] = ["node12", "node16", "node20", "node24"];

export type ActionRuntime =
  | { kind: "composite"; steps: unknown[] }
  | { kind: "node"; using: string };

/**
 * Decides what an `action.yml` `runs:` section is, failing closed. `using` is trimmed and
 * lowercased (`Docker`, ` composite` are still docker and composite). Docker is refused,
 * composite must carry a steps array, node runtimes are allowed from an explicit list, and any
 * other value (or none) is refused, so a spelling act might still run can never skip the checks.
 */
export function classifyActionRuntime(runs: unknown, label: string): ActionRuntime {
  if (!isObj(runs))
    throw new PlanError("nested-action", `${label}: action.yml has no runs section`);
  const raw = runs.using;
  const using = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (using === "docker") {
    throw new PlanError("docker:// action", `${label} is a docker action, which is unsupported`);
  }
  if (using === "composite") {
    if (!Array.isArray(runs.steps)) {
      throw new PlanError("nested-action", `${label}: a composite action without a steps list`);
    }
    return { kind: "composite", steps: runs.steps };
  }
  if (NODE_RUNTIMES.includes(using)) return { kind: "node", using };
  throw new PlanError(
    "nested-action",
    `${label}: unsupported runs.using ${JSON.stringify(raw)} (allowed: composite, ${NODE_RUNTIMES.join(", ")})`,
  );
}
