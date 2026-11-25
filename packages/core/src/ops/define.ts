import { z } from "zod";
import type { Db } from "../db";
import type { Scope } from "../db/repos";
import type { TrustAnchors } from "../approvals/attestation";
import type { RelyingParty } from "../approvals/webauthn";
import type { WebhookService } from "../webhooks/service";
import type { GithubFacts, GithubUserLookup } from "../github/api";
import type { InstallationClaims } from "../github/claim";
import type { UserGithub } from "../auth/user-tokens";
import type { RunDispatcher } from "../poll/dispatch";
import type { DefaultBranchRunner, RepoReaderFactory } from "../poll/onboarding-forge";
import type { SecretStore } from "../secrets/store";
import type { SecretVault } from "../secrets/vault";
import type { DoctorReport } from "../doctor/types";
import type { BackupConfig } from "../db/backup";
import type { SettingsRuntime } from "../settings/resolve";
import type { Principal } from "./principal";
import type { Role } from "./roles";

/** What an operation does to the world. Drives MCP annotations and audit. */
export type Effect = "read" | "write" | "destructive";

/**
 * How the caller must prove itself. `token`: a bearer token or session holding at least
 * `minRole`. `signature`: a human-signed assertion (offline statement or WebAuthn). No bearer
 * token can ever satisfy `signature`, so those ops are never exposed over MCP or token REST.
 * `account`: a signed-in GitHub user's web session with no org picked (onboarding); no token, no
 * member and no org session satisfies it, and it is never an MCP tool. `minRole` is unused.
 */
export type OpAuth = { type: "token" | "signature" | "instance" | "account"; minRole: Role };

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
  /** The secrets vault; absent when the server has no master key. Vault ops refuse without it. */
  vault?: SecretVault | undefined;
  /** The secret store holding the orgs' audit signing keys; absent without a master key. */
  auditStore?: SecretStore | undefined;
  /** Starts installation claims (hosted); absent without a master key. */
  claims?: InstallationClaims | undefined;
  /** GitHub App API facts for `resync_installation`; absent when no App is configured. */
  githubFacts?: GithubFacts | undefined;
  /** Starts a `workflow_dispatch` run through the poller; absent where this process has none. */
  runDispatcher?: RunDispatcher | undefined;
  /** Read-only reader of one repo of an installation (the onboarding preview); absent without a GitHub App. */
  repoReader?: RepoReaderFactory | undefined;
  /** Starts a default-branch push run through the poller; absent where this process has none. */
  defaultBranchRunner?: DefaultBranchRunner | undefined;
  /** Resolves a GitHub login to its numeric id (invites); absent without a GitHub App. */
  githubUsers?: GithubUserLookup | undefined;
  /** Calls GitHub with a signed-in user's own token (onboarding); absent without sign-in. */
  userGithub?: UserGithub | undefined;
  /** The adapter that carried the call; undefined for in-process callers. */
  transport?: "mcp" | "rest" | undefined;
  /** The instance's per-org concurrency cap, for the instance ops that clamp to it. */
  instanceOrgCap?: number | undefined;
  /** `org-slug/project-slug` pairs the running poll config names statically; empty when none. */
  staticPollProjects?: readonly string[] | undefined;
  /** Where `db_backup` may write; absent when the server was not set up for it. */
  backup?: BackupConfig | undefined;
  /** Outbound webhooks; absent without a master key. */
  webhooks?: WebhookService | undefined;
  /** WebAuthn relying party (id and allowed origins); absent when not configured. */
  webauthn?: RelyingParty | undefined;
  /** Attestation trust anchors; the pinned vendor roots when absent (tests inject their own). */
  attestationAnchors?: TrustAnchors | undefined;
  /** Runs the readiness checks against the running server; absent where there is no server. */
  doctor?: (() => Promise<DoctorReport>) | undefined;
  /** The settings registry with its environment and file layers; the shipped registry, bare, when absent. */
  settings?: SettingsRuntime | undefined;
  /** True when the call came in over MCP: `set_setting` refuses settings MCP may not change. */
  viaMcp?: boolean | undefined;
  /**
   * Set by the dispatcher when a web session passed a fresh passkey step-up for exactly this
   * action and target (#430). Absent otherwise: a handler that opens a session path must require it.
   */
  stepUp?: { action: string; target: string | undefined } | undefined;
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
  /**
   * For an op whose real role requirement is set in the handler (per org policy): replaces the
   * generated "Requires role X." sentence in tool descriptions, so agents are not misled.
   */
  roleNote?: string;
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
  /**
   * Input fields that carry a secret value. They are redacted from every audit entry and refused
   * in a query string (URLs get logged), and the call is refused over plain http.
   */
  secretInputFields?: readonly string[];
  /**
   * Input fields that are not secret but too bulky or too identifying for the audit log (a public
   * key: the log carries its fingerprint through `auditDetail` instead). Replaced with "[omitted]"
   * in every audit entry. Unlike `secretInputFields` they may travel over http and in OpenAPI.
   */
  logOmitFields?: readonly string[];
  /** False keeps the op out of MCP tools: a value in tool input sits in an agent's context. */
  mcp?: boolean;
  /**
   * For a long-running write that must not hold the database's write lock (`db_backup`): the
   * dispatcher runs the handler with the plain handle, outside any transaction, then writes the
   * audit row (success or failure) in its own short transaction afterwards. The handler must not
   * need atomicity with the audit row.
   */
  outsideTransaction?: boolean;
  /** For an `outsideTransaction` op: extra fields recorded in the audit input on success. */
  auditDetail?: (output: z.infer<O>) => Record<string, unknown>;
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
  roleNote?: string | undefined;
  untrustedOutput: boolean;
  scope: "org" | "project";
  http: HttpBinding;
  oneTimeSecretFields: readonly string[];
  secretInputFields: readonly string[];
  logOmitFields: readonly string[];
  mcp: boolean;
  outsideTransaction: boolean;
  auditDetail?: ((output: unknown) => Record<string, unknown>) | undefined;
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
  for (const f of spec.secretInputFields ?? []) {
    if (!(f in spec.input.shape))
      throw new Error(`${spec.name}: secretInputFields names "${f}", not an input field`);
    if (spec.http.method === "GET")
      throw new Error(`${spec.name}: a value-bearing op cannot be a GET`);
  }
  for (const f of spec.logOmitFields ?? []) {
    if (!(f in spec.input.shape))
      throw new Error(`${spec.name}: logOmitFields names "${f}", not an input field`);
  }
  for (const param of pathParams(spec.http.path)) {
    if (!(param in spec.input.shape)) {
      throw new Error(`${spec.name}: path parameter {${param}} is not an input field`);
    }
  }
  // An instance op has no org or project scope: it names its target in its own input. The org and
  // project fields would only invite a caller to think an org grant matters.
  const input =
    spec.auth.type === "instance" || spec.auth.type === "account"
      ? spec.input.strict()
      : spec.input
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
    roleNote: spec.roleNote,
    untrustedOutput: spec.untrustedOutput,
    scope: spec.scope,
    http: spec.http,
    oneTimeSecretFields: spec.oneTimeSecretFields ?? [],
    secretInputFields: spec.secretInputFields ?? [],
    logOmitFields: spec.logOmitFields ?? [],
    mcp: spec.mcp ?? true,
    outsideTransaction: spec.outsideTransaction ?? false,
    auditDetail: spec.auditDetail ? (out) => spec.auditDetail!(out as z.infer<O>) : undefined,
    handler: (ctx, raw) => spec.handler(ctx, raw as z.infer<I>),
  };
}
