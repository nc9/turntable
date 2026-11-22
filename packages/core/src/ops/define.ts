import { z } from "zod";
import type { Db } from "../db";
import type { Scope } from "../db/repos";
import type { Principal } from "./principal";
import type { Role } from "./roles";

/** What an operation does to the world. Drives MCP annotations and audit. */
export type Effect = "read" | "write" | "destructive";

/**
 * How the caller must prove itself. `token`: a bearer token or session holding at least
 * `minRole`. `signature`: a human-signed assertion (offline statement or WebAuthn). No bearer
 * token can ever satisfy `signature`, so those ops are never exposed over MCP or token REST.
 */
export type OpAuth = { type: "token" | "signature"; minRole: Role };

export type HttpBinding = {
  method: "GET" | "POST" | "DELETE";
  /** Relative to /api/v1. `{name}` segments bind input fields. */
  path: string;
};

export type OpContext = {
  db: Db;
  /** Resolved from the principal's grant; the input's org and project can only narrow it. */
  scope: Scope;
  principal: Principal;
  now: () => number;
};

export type OpSpec<I extends z.ZodObject, O extends z.ZodType> = {
  /** snake_case. Also the MCP tool name and the OpenAPI operationId. */
  name: string;
  /** One line, for tool lists. */
  summary: string;
  /** For agents: what it does, when to use it, cost and side effects. */
  description: string;
  input: I;
  output: O;
  effect: Effect;
  auth: OpAuth;
  /** True when the output carries log or forge text (branch names, workflow paths, log lines). */
  untrustedOutput: boolean;
  /**
   * `project`: needs one project, from the input or a project-scoped token. `org`: works at
   * org level; a project given in the input (or by the token) narrows it.
   */
  scope: "org" | "project";
  http: HttpBinding;
  /**
   * Output fields that carry a one-time secret by design (`create_api_token`'s `token`). The
   * output lint rejects any other secret-looking field name.
   */
  oneTimeSecretFields?: readonly string[];
  handler(ctx: OpContext, input: z.infer<I>): Promise<z.infer<O>>;
};

/** A registered operation: scope fields added to the input, handler type-erased. */
export type Op = {
  name: string;
  summary: string;
  description: string;
  /** Input including the `org` and `project` scope fields. Strict: unknown keys are errors. */
  input: z.ZodObject;
  output: z.ZodType;
  effect: Effect;
  auth: OpAuth;
  untrustedOutput: boolean;
  scope: "org" | "project";
  http: HttpBinding;
  oneTimeSecretFields: readonly string[];
  handler(ctx: OpContext, input: unknown): Promise<unknown>;
};

export const SCOPE_FIELDS = ["org", "project"] as const;

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)].map((m) => m[1]!);
}

export function defineOp<I extends z.ZodObject, O extends z.ZodType>(spec: OpSpec<I, O>): Op {
  if (!NAME.test(spec.name)) throw new Error(`op name must be snake_case: ${spec.name}`);
  if (spec.summary.length === 0 || spec.summary.length > 120) {
    throw new Error(`${spec.name}: summary must be 1 to 120 characters`);
  }
  if (spec.description.length < 40) {
    throw new Error(`${spec.name}: description must tell an agent what it does and when to use it`);
  }
  if (!spec.http.path.startsWith("/")) throw new Error(`${spec.name}: http.path must start with /`);
  for (const field of SCOPE_FIELDS) {
    if (field in spec.input.shape) {
      throw new Error(`${spec.name}: "${field}" is added by defineOp; do not declare it`);
    }
  }
  for (const param of pathParams(spec.http.path)) {
    if (!(param in spec.input.shape)) {
      throw new Error(`${spec.name}: path parameter {${param}} is not an input field`);
    }
  }
  const input = spec.input
    .extend({
      org: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Org slug. Defaults to the caller's org; a token can only name its own."),
      project: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe(
          spec.scope === "project"
            ? "Project slug. Required unless the token is scoped to one project."
            : "Project slug to narrow to. A project-scoped token is always narrowed to its project.",
        ),
    })
    .strict();
  return {
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    input,
    output: spec.output,
    effect: spec.effect,
    auth: spec.auth,
    untrustedOutput: spec.untrustedOutput,
    scope: spec.scope,
    http: spec.http,
    oneTimeSecretFields: spec.oneTimeSecretFields ?? [],
    handler: (ctx, raw) => spec.handler(ctx, raw as z.infer<I>),
  };
}
