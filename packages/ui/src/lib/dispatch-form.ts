// The "Run workflow" form's logic (#617): which workflows can be dispatched, the starting values
// of their inputs, and the client-side check. The server checks again (run_dispatch); this only
// saves a round trip, with the same rules as validateDispatchInputs in core.
import type { DispatchInput, PreviewWorkflow } from "@/api/onboarding";

export type DispatchWorkflow = PreviewWorkflow & { dispatch_inputs: DispatchInput[] };

/** The workflows that declare `on.workflow_dispatch`. */
export function dispatchWorkflows(all: readonly PreviewWorkflow[]): DispatchWorkflow[] {
  return all.filter((w): w is DispatchWorkflow => Array.isArray(w.dispatch_inputs));
}

/** The form's starting values: the declared default, else the first choice, else empty/false. */
export function initialInputs(decls: readonly DispatchInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of decls) {
    out[d.name] =
      d.default !== null
        ? d.default
        : d.type === "boolean"
          ? "false"
          : d.type === "choice"
            ? (d.options[0] ?? "")
            : "";
  }
  return out;
}

/** Field errors by input name, plus `ref`; empty when the form may be sent. */
export function validateDispatch(
  decls: readonly DispatchInput[],
  ref: string,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (ref.trim() === "") errors.ref = "Enter a branch or tag.";
  for (const d of decls) {
    const v = values[d.name] ?? "";
    if (d.required && v === "") errors[d.name] = "Required.";
    else if (d.type === "number" && v !== "" && !Number.isFinite(Number(v)))
      errors[d.name] = "Must be a number.";
    else if (d.type === "choice" && !d.options.includes(v))
      errors[d.name] = "Pick one of the options.";
  }
  return errors;
}
