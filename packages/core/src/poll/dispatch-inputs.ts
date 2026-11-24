// `workflow_dispatch` inputs: validated against what the workflow file declares under
// `on.workflow_dispatch.inputs`, with GitHub's semantics. The caller's map is strings, as GitHub's
// API sends it. The result has both views GitHub gives a job: `github.event.inputs.*` (strings)
// and the `inputs.*` context (booleans and numbers typed).
import { parse } from "yaml";

/** Total bytes of input names and values one dispatch may carry. */
export const MAX_DISPATCH_INPUT_BYTES = 64 * 1024;
/** GitHub allows 25 top-level inputs. */
export const MAX_DISPATCH_INPUTS = 25;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type DispatchInputs =
  | {
      ok: true;
      /** `github.event.inputs`: every declared input, as a string. */
      strings: Record<string, string>;
      /** The `inputs` context: booleans and numbers are typed. */
      typed: Record<string, string | boolean | number>;
    }
  | { ok: false; reason: string };

const ENVIRONMENT = /^[A-Za-z0-9._ -]{1,255}$/;

/** The workflow's `on.workflow_dispatch` entry, or undefined when it does not trigger on it. */
function dispatchConfig(yaml: string): { inputs: Obj } | undefined {
  let doc: unknown;
  try {
    doc = parse(yaml, { merge: true });
  } catch {
    return undefined;
  }
  if (!isObj(doc)) return undefined;
  // YAML 1.1 reads a bare `on` key as boolean true.
  const on = doc.on ?? doc["true"];
  if (on === "workflow_dispatch") return { inputs: {} };
  if (Array.isArray(on)) return on.includes("workflow_dispatch") ? { inputs: {} } : undefined;
  if (!isObj(on) || !("workflow_dispatch" in on)) return undefined;
  const cfg = on.workflow_dispatch;
  return { inputs: isObj(cfg) && isObj(cfg.inputs) ? cfg.inputs : {} };
}

const show = (v: unknown): string => (typeof v === "string" ? v : String(v));

export function validateDispatchInputs(
  yaml: string,
  given: Record<string, string>,
): DispatchInputs {
  const cfg = dispatchConfig(yaml);
  if (!cfg) return { ok: false, reason: "the workflow does not declare on.workflow_dispatch" };
  const names = Object.keys(given);
  if (names.length > MAX_DISPATCH_INPUTS) {
    return { ok: false, reason: `at most ${MAX_DISPATCH_INPUTS} inputs, got ${names.length}` };
  }
  let bytes = 0;
  for (const [k, v] of Object.entries(given)) bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
  if (bytes > MAX_DISPATCH_INPUT_BYTES) {
    return {
      ok: false,
      reason: `inputs total ${bytes} bytes; the limit is ${MAX_DISPATCH_INPUT_BYTES}`,
    };
  }
  const unknown = names.filter((n) => !Object.hasOwn(cfg.inputs, n));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `unknown input${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
    };
  }
  const strings: Record<string, string> = {};
  const typed: Record<string, string | boolean | number> = {};
  for (const [name, raw] of Object.entries(cfg.inputs)) {
    const decl = isObj(raw) ? raw : {};
    const type = decl.type === undefined ? "string" : show(decl.type);
    if (!["string", "boolean", "number", "choice", "environment"].includes(type)) {
      return { ok: false, reason: `input ${name}: unsupported type ${type}` };
    }
    const has = Object.hasOwn(given, name);
    let value: string;
    if (has) value = given[name] as string;
    else if (decl.default !== undefined && decl.default !== null) value = show(decl.default);
    else if (decl.required === true) {
      return { ok: false, reason: `input ${name} is required and has no default` };
    } else value = type === "boolean" ? "false" : "";
    if (has && decl.required === true && value === "") {
      return { ok: false, reason: `input ${name} is required and was empty` };
    }
    if (type === "boolean" && value !== "true" && value !== "false") {
      return { ok: false, reason: `input ${name} must be true or false` };
    }
    if (type === "number" && value !== "" && !Number.isFinite(Number(value))) {
      return { ok: false, reason: `input ${name} must be a number` };
    }
    if (type === "choice") {
      const options = Array.isArray(decl.options) ? decl.options.map(show) : [];
      // An unset optional choice takes the first option, as GitHub does.
      if (!has && value === "" && options.length > 0) value = options[0] as string;
      if (!options.includes(value)) {
        return { ok: false, reason: `input ${name} must be one of: ${options.join(", ")}` };
      }
    }
    if (type === "environment" && value !== "" && !ENVIRONMENT.test(value)) {
      return { ok: false, reason: `input ${name} is not a valid environment name` };
    }
    strings[name] = value;
    typed[name] =
      type === "boolean"
        ? value === "true"
        : type === "number" && value !== ""
          ? Number(value)
          : value;
  }
  return { ok: true, strings, typed };
}
