import type { Op } from "./define";
import { outputJsonSchema, type JsonSchema } from "./json-schema";
import type { OpRegistry } from "./registry";

/** Field names that must never appear in an operation's output. */
const SECRETISH = /secret|password|passwd|private_?key|api_?key|token_value|credential/i;
/** Exact names that look like credentials; allowed only as a declared one-time secret. */
const TOKENISH = /^(token|access_token|refresh_token|bearer|authorization|auth_token)$/i;

/**
 * Boolean presence flags: they say whether a credential exists and carry none (`has_credential` on
 * a release lane target). Allowed by exact name.
 */
const PRESENCE_FLAGS = new Set(["has_credential"]);

function names(schema: JsonSchema | undefined, out: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    out.add(name);
    names(prop, out);
  }
  names(schema.items as JsonSchema | undefined, out);
  if (typeof schema.additionalProperties === "object") {
    names(schema.additionalProperties as JsonSchema, out);
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    for (const sub of (schema[key] as JsonSchema[] | undefined) ?? []) names(sub, out);
  }
}

export function outputFieldNames(op: Op): string[] {
  const out = new Set<string>();
  names(outputJsonSchema(op), out);
  return [...out];
}

/**
 * Problems with how operations expose fields: a secret-looking output field name, unless it is
 * a declared one-time secret. Returns human-readable findings; empty means clean.
 */
export function lintOutputSchemas(registry: OpRegistry): string[] {
  const findings: string[] = [];
  for (const op of registry.ops) {
    for (const name of outputFieldNames(op)) {
      if (op.oneTimeSecretFields.includes(name) || PRESENCE_FLAGS.has(name)) continue;
      if (SECRETISH.test(name) || TOKENISH.test(name)) {
        findings.push(`${op.name}: output field "${name}" looks like a secret`);
      }
    }
    for (const declared of op.oneTimeSecretFields) {
      if (!outputFieldNames(op).includes(declared)) {
        findings.push(`${op.name}: oneTimeSecretFields names "${declared}", not in the output`);
      }
    }
  }
  return findings;
}
