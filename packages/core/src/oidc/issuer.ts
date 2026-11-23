// The per-org OIDC issuer: discovery, JWKS, and minting a job's identity token.
//
// A token says "this attempt of this job of this run, in this org and project, at this ref,
// as this trust class". A cloud trust policy matches on `sub` (or the other claims) and hands
// out short-lived cloud credentials, so no long-lived cloud secret ever sits in CI.
//
// Policy (all in this file, none left to the caller):
//  - the caller is an attempt, proven by its attempt credential, and the attempt is running;
//  - the class is the one the scheduler recorded after the demotion rule, never one the caller
//    names; unrecorded is refused; `untrusted_pr` is refused unless an operator allows it;
//  - the audience is mandatory and chosen per request;
//  - the token lives at most TOKEN_SECONDS and carries a unique jti;
//  - every mint, and every refusal, is audited.
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import {
  appendAudit,
  getAttempt,
  getFreeze,
  getJob,
  getOrgById,
  getProject,
  getProjectOidcAudiences,
  getRun,
} from "../db/repos";
import { auditFailure } from "../audit/failures";
import { OidcKeyStore, MAX_TOKEN_SECONDS, OIDC_ALG } from "./keys";

/** Token lifetime. Short on purpose; never above MAX_TOKEN_SECONDS (10 minutes). */
export const TOKEN_SECONDS = 300;
/** How long before `iat` a token is already valid, for relying parties with a slow clock. */
export const NBF_LEEWAY_SECONDS = 30;
/** Classes that may get a token unless an operator widens it. */
export const DEFAULT_OIDC_CLASSES: readonly string[] = ["protected", "release"];
const KNOWN_CLASSES = ["protected", "release", "trusted_pr", "untrusted_pr"];

export type MintDenial =
  | "bad_audience"
  | "unknown_attempt"
  | "attempt_not_running"
  | "class_unrecorded"
  | "class_not_allowed"
  | "frozen"
  | "audience_not_allowed";

export type MintResult =
  | { ok: true; token: string; expiresAt: number; jti: string; kid: string }
  | { ok: false; reason: MintDenial };

export interface IssuerOptions {
  db: Db;
  masterKey: Buffer;
  /** `<base>/<org slug>` is an org's issuer URL. Normally `<public url>/oidc`. */
  baseUrl: string;
  allowClasses?: readonly string[];
  now?: () => number;
}

/** Parses an allow list such as "protected,release". Unknown names are an error. */
export function parseAllowClasses(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_OIDC_CLASSES];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of list) {
    if (!KNOWN_CLASSES.includes(c)) throw new Error(`unknown trust class in OIDC allow list: ${c}`);
  }
  return list;
}

/** Audience: required, one string, printable, bounded. */
export function validAudience(aud: unknown): aud is string {
  return (
    typeof aud === "string" && aud.length > 0 && aud.length <= 256 && /^[\x21-\x7e]+$/.test(aud)
  );
}

/** A sub segment: values the forge controls cannot add a `:` and forge another segment. */
const seg = (v: string | null | undefined): string =>
  v === null || v === undefined || v === ""
    ? "none"
    : encodeURIComponent(v).replaceAll("%2F", "/").replaceAll("%40", "@");

export class OidcIssuer {
  readonly keys: OidcKeyStore;
  readonly #o: IssuerOptions;
  readonly #allow: readonly string[];
  readonly #now: () => number;

  constructor(o: IssuerOptions) {
    this.#o = o;
    this.keys = new OidcKeyStore(o.db, o.masterKey);
    this.#allow = o.allowClasses ?? DEFAULT_OIDC_CLASSES;
    this.#now = o.now ?? Date.now;
  }

  /** Whether a trust class may get a token at all (the operator's allow list). */
  allowsClass(klass: string): boolean {
    return this.#allow.includes(klass);
  }

  issuerUrl(orgSlug: string): string {
    return `${this.#o.baseUrl.replace(/\/+$/, "")}/${orgSlug}`;
  }

  discovery(orgSlug: string): Record<string, unknown> {
    const iss = this.issuerUrl(orgSlug);
    return {
      issuer: iss,
      jwks_uri: `${iss}/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [OIDC_ALG],
      claims_supported: [
        "iss",
        "aud",
        "sub",
        "iat",
        "nbf",
        "exp",
        "jti",
        "org",
        "org_id",
        "project",
        "project_id",
        "repository",
        "repository_owner",
        "ref",
        "sha",
        "workflow",
        "workflow_ref",
        "job",
        "run_id",
        "job_id",
        "attempt_id",
        "run_attempt",
        "rerun",
        "trust_class",
        "event_name",
        "actor",
        "environment",
      ],
    };
  }

  /**
   * Mints a token for a running attempt. `orgId` comes from the verified attempt credential and
   * `audience` from the request; everything else is read from the stored run, job and attempt.
   */
  async mint(req: { orgId: string; attemptId: string; audience: unknown }): Promise<MintResult> {
    const { db } = this.#o;
    const now = this.#now();
    const deny = async (reason: MintDenial, scopeProject?: string): Promise<MintResult> => {
      await auditFailure(
        db,
        {
          orgId: req.orgId,
          principalKind: "attempt",
          principalId: req.attemptId,
          source: req.attemptId,
          kind: `oidc_denied:${reason}`,
          op: "oidc_mint",
          outcome: `error:${reason}`,
          detail: {
            attempt: req.attemptId,
            ...(validAudience(req.audience) ? { aud: req.audience } : {}),
            ...(scopeProject ? { project_id: scopeProject } : {}),
          },
        },
        () => now,
      );
      return { ok: false, reason };
    };
    if (!validAudience(req.audience)) return deny("bad_audience");
    const aud = req.audience;

    const attempt = await getAttempt(db, { orgId: req.orgId }, req.attemptId);
    if (!attempt) return deny("unknown_attempt");
    const scope = { orgId: req.orgId, projectId: attempt.projectId };
    const job = await getJob(db, scope, attempt.jobId);
    const run = job ? await getRun(db, scope, job.runId) : undefined;
    const project = await getProject(db, { orgId: req.orgId }, attempt.projectId);
    const org = await getOrgById(db, req.orgId);
    if (!job || !run || !project || !org) return deny("unknown_attempt");
    if (attempt.state !== "running") return deny("attempt_not_running", project.id);
    const klass = attempt.trustClass;
    if (!klass) return deny("class_unrecorded", project.id);
    if (!this.#allow.includes(klass)) return deny("class_not_allowed", project.id);
    // An incident freeze stops identity tokens too: a stolen credential cannot mint through one.
    if ((await getFreeze(db, scope)).frozen) return deny("frozen", project.id);
    // The project's own allow list, when it has one: any other audience is refused (and audited
    // with the audience asked for, by `deny`). No list: any audience, as before.
    const allowedAud = await getProjectOidcAudiences(db, scope);
    if (allowedAud !== null && !allowedAud.includes(aud)) {
      return deny("audience_not_allowed", project.id);
    }

    const iat = Math.floor(now / 1000);
    const exp = iat + Math.min(TOKEN_SECONDS, MAX_TOKEN_SECONDS);
    const jti = randomUUID();
    const repo = run.repo ?? null;
    const environment = null; // jobs do not record an environment yet
    const claims = {
      iss: this.issuerUrl(org.slug),
      aud,
      sub:
        `org:${seg(org.slug)}:project:${seg(project.slug)}:repo:${seg(repo)}` +
        `:ref:${seg(run.ref)}:class:${klass}:env:${seg(environment)}`,
      iat,
      // A little before iat, so a relying party whose clock is slightly behind still accepts it.
      nbf: iat - NBF_LEEWAY_SECONDS,
      exp,
      jti,
      org: org.slug,
      org_id: org.id,
      project: project.slug,
      project_id: project.id,
      repository: repo,
      repository_owner: repo ? repo.split("/")[0] : null,
      ref: run.ref,
      sha: run.sha,
      workflow: run.workflowName ?? run.workflowPath,
      workflow_ref: repo ? `${repo}/${run.workflowPath}@${run.ref}` : null,
      job: job.jobKey,
      run_id: run.id,
      job_id: job.id,
      attempt_id: attempt.id,
      // The job's attempt number (1 for the first try), as GitHub's run_attempt; and whether this
      // attempt was asked for by a person or agent (a rerun).
      run_attempt: attempt.attempt,
      rerun: attempt.rerunReason !== null,
      trust_class: klass,
      event_name: run.event,
      // An unknown actor (a tag run has none) is left out, never claimed as null or a guess.
      ...(run.actor ? { actor: run.actor } : {}),
      environment,
    };
    const { token, kid } = await this.keys.signJwt(org.id, claims, now);
    await appendAudit(db, scope, {
      principalKind: "attempt",
      principalId: attempt.id,
      op: "oidc_mint",
      effect: "use",
      outcome: "ok",
      input: {
        aud,
        kid,
        jti,
        sub: claims.sub,
        run: run.id,
        job: job.id,
        attempt: attempt.id,
        class: klass,
        exp,
      },
    });
    return { ok: true, token, expiresAt: exp * 1000, jti, kid };
  }
}
