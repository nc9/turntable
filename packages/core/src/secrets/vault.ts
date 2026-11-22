// The secrets vault: scoped, versioned, audited secrets for jobs, and the policy that decides
// every use. Delivery to a sandbox is not built here (the secrets proxy, #15, will call `use`).
//
// Rules the code below enforces, in one place:
//  - A value is returned only by `use`, to in-process callers, after policy allowed it. No
//    method, error or audit entry carries a value.
//  - The caller cannot say what class a run has. The class is the one the scheduler recorded on
//    the attempt, after the demotion rule. Unrecorded means refused.
//  - `untrusted_pr` can never be allowed: refused when a secret is written and again at use.
//  - Policy never guesses: two equally specific matches, an unknown environment, an empty
//    destination list and a failed decrypt are all denials.
import { matchesPatterns } from "@longshore/act-runner";
import type { Db } from "../db";
import {
  listVaultCiphertexts,
  setVaultCiphertext,
  addVaultVersion,
  deleteVaultSecret,
  findVaultSecret,
  getAttempt,
  getJob,
  getRun,
  getVaultSecretById,
  getVersionCiphertext,
  insertVaultSecret,
  listVaultSecrets,
  listVaultVersions,
  scopeKeyOf,
  touchVaultSecret,
  vaultCandidates,
  appendAudit,
  type VaultSecretRow,
  type VaultVersionMeta,
} from "../db/repos";
import { credentialsFor, normalizeRef, type TrustClass } from "../trust";
import { auditFailure } from "../audit/failures";
import { open, recordVersion, seal, vaultAad } from "./crypto";

/** Classes a secret may name. `untrusted_pr` is deliberately absent and can never be added. */
export const ALLOWED_SECRET_CLASSES = ["protected", "release", "trusted_pr"] as const;
export const DEFAULT_SECRET_CLASSES: readonly string[] = ["protected", "release"];
/** Longest rotation overlap: seven days. */
export const MAX_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_VALUE_BYTES = 16 * 1024;

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_PATTERN = /^[A-Za-z0-9._/*-]{1,200}$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** A refusal the caller can show: it says what is wrong with the input, never echoes a value. */
export class VaultInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultInputError";
  }
}

export interface SecretScopeInput {
  name: string;
  /** Project id (not slug), or null for an org-wide secret. */
  projectId?: string | null | undefined;
  environment?: string | null | undefined;
  refPattern?: string | null | undefined;
}

export interface SecretPolicyInput {
  trustClasses?: readonly string[] | undefined;
  destinations?: readonly string[] | undefined;
}

interface NormalizedScope {
  name: string;
  projectId: string | null;
  environment: string | null;
  refPattern: string | null;
}

export function normalizeScope(i: SecretScopeInput): NormalizedScope {
  if (!NAME.test(i.name)) throw new VaultInputError("invalid secret name");
  const environment = i.environment ?? null;
  if (environment !== null && !ENVIRONMENT.test(environment)) {
    throw new VaultInputError("invalid environment name");
  }
  let refPattern = i.refPattern ?? null;
  if (refPattern !== null) {
    if (!REF_PATTERN.test(refPattern)) throw new VaultInputError("invalid ref pattern");
    refPattern = normalizeRef(refPattern);
  }
  return { name: i.name, projectId: i.projectId ?? null, environment, refPattern };
}

export function normalizePolicy(i: SecretPolicyInput): {
  trustClasses: string[];
  destinations: string[];
} {
  const classes = [...new Set(i.trustClasses ?? DEFAULT_SECRET_CLASSES)];
  for (const c of classes) {
    if (!(ALLOWED_SECRET_CLASSES as readonly string[]).includes(c)) {
      throw new VaultInputError(
        c === "untrusted_pr"
          ? "untrusted_pr can never be allowed to use a secret"
          : `unknown trust class: ${c}`,
      );
    }
  }
  if (classes.length === 0) throw new VaultInputError("at least one trust class is required");
  const destinations = [...new Set((i.destinations ?? []).map((d) => d.toLowerCase()))];
  for (const d of destinations) {
    if (!HOST_PATTERN.test(d) || d.length > 253) {
      throw new VaultInputError("destinations are host names or *.suffix patterns");
    }
    if (d === "*" || /^\*\.[a-z0-9-]+$/.test(d)) {
      // `*.com` style: a wildcard over a bare TLD matches half the internet.
      throw new VaultInputError("a wildcard destination needs at least two labels (*.example.com)");
    }
  }
  return { trustClasses: classes, destinations };
}

const checkValue = (value: string): void => {
  if (value.length === 0) throw new VaultInputError("value must not be empty");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    throw new VaultInputError(`value is larger than ${MAX_VALUE_BYTES} bytes`);
  }
};

/** What listings and write results carry: metadata only. */
export interface SecretView {
  id: string;
  name: string;
  project_id: string | null;
  environment: string | null;
  ref_pattern: string | null;
  trust_classes: string[];
  destinations: string[];
  current_version: number;
  versions: {
    version: number;
    created_at: number;
    created_by: string;
    valid_until: number | null;
  }[];
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

function view(row: VaultSecretRow, versions: VaultVersionMeta[]): SecretView {
  return {
    id: row.id,
    name: row.name,
    project_id: row.projectId,
    environment: row.environment,
    ref_pattern: row.refPattern,
    trust_classes: JSON.parse(row.trustClasses) as string[],
    destinations: JSON.parse(row.destinations) as string[],
    current_version: row.currentVersion,
    versions: versions.map((v) => ({
      version: v.version,
      created_at: v.createdAt,
      created_by: v.createdBy,
      valid_until: v.validUntil,
    })),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_used_at: row.lastUsedAt,
  };
}

export interface UseRequest {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  attemptId: string;
  name: string;
  /** The host the value is going to. Required: a use without a destination is refused. */
  destination: string;
  /** A version the caller pinned at job start. Default: the current one. */
  version?: number;
}

export type UseDenial =
  | "unknown_run"
  | "attempt_not_running"
  | "class_unrecorded"
  | "class_not_allowed"
  | "release_lane_only"
  | "no_match"
  | "ambiguous"
  | "environment_unavailable"
  | "destination_not_allowed"
  | "version_unavailable"
  | "decrypt_failed";

export type UseResult =
  | { ok: true; value: string; version: number; secretId: string }
  | { ok: false; reason: UseDenial };

export interface VaultOptions {
  db: Db;
  masterKey: Buffer;
  /**
   * Which process this is. Secrets for `release` class jobs (publish credentials) are used only
   * by the release lane: any other lane refuses them before it decrypts anything. Default `main`.
   */
  lane?: "main" | "release";
  now?: () => number;
}

export class SecretVault {
  readonly #db: Db;
  readonly #key: Buffer;
  readonly #now: () => number;
  readonly #lane: "main" | "release";

  constructor(o: VaultOptions) {
    this.#lane = o.lane ?? "main";
    this.#db = o.db;
    this.#key = o.masterKey;
    this.#now = o.now ?? Date.now;
  }

  /**
   * Stores a value under a scope: creates the secret, or adds a version (and replaces the
   * policy) when that exact scope already exists. The old version stops being usable at once; use
   * `rotate` for an overlap.
   */
  async set(
    orgId: string,
    actor: string,
    scope: SecretScopeInput,
    value: string,
    policy: SecretPolicyInput = {},
  ): Promise<{ secret: SecretView; created: boolean }> {
    const sc = normalizeScope(scope);
    const pol = normalizePolicy(policy);
    checkValue(value);
    const existing = await findVaultSecret(
      this.#db,
      orgId,
      sc.name,
      scopeKeyOf(sc.projectId, sc.environment, sc.refPattern),
    );
    if (!existing) {
      const row = await insertVaultSecret(
        this.#db,
        orgId,
        { ...sc, ...pol, createdBy: actor },
        (id, version) =>
          seal(this.#key, value, vaultAad(orgId, id, version, sc.name), "job", orgId),
      );
      return { secret: view(row, await listVaultVersions(this.#db, orgId, row.id)), created: true };
    }
    await addVaultVersion(
      this.#db,
      orgId,
      existing.id,
      { createdBy: actor, previousValidUntil: this.#now(), policy: pol },
      (version) =>
        seal(this.#key, value, vaultAad(orgId, existing.id, version, sc.name), "job", orgId),
    );
    return { secret: (await this.#viewById(orgId, existing.id))!, created: false };
  }

  /** Adds a version. The previous one stays usable for `overlapMs` (0 to 7 days). */
  async rotate(
    orgId: string,
    actor: string,
    scope: SecretScopeInput,
    value: string,
    overlapMs = 0,
  ): Promise<SecretView | undefined> {
    const sc = normalizeScope(scope);
    checkValue(value);
    if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs > MAX_OVERLAP_MS) {
      throw new VaultInputError("overlap must be between 0 and 7 days");
    }
    const existing = await findVaultSecret(
      this.#db,
      orgId,
      sc.name,
      scopeKeyOf(sc.projectId, sc.environment, sc.refPattern),
    );
    if (!existing) return undefined;
    await addVaultVersion(
      this.#db,
      orgId,
      existing.id,
      { createdBy: actor, previousValidUntil: this.#now() + overlapMs },
      (version) =>
        seal(this.#key, value, vaultAad(orgId, existing.id, version, sc.name), "job", orgId),
    );
    return this.#viewById(orgId, existing.id);
  }

  /**
   * Re-seals every version of an org under the org's own key (format v3), in place; the values
   * and versions are unchanged. Versions already v3 are skipped. Returns how many changed.
   */
  async reseal(orgId: string): Promise<number> {
    let n = 0;
    for (const v of await listVaultCiphertexts(this.#db, orgId)) {
      if (recordVersion(v.ciphertext) === "v3") continue;
      const aad = vaultAad(orgId, v.secretId, v.version, v.name);
      const value = open(this.#key, v.ciphertext, aad, "job");
      await setVaultCiphertext(
        this.#db,
        orgId,
        v.secretId,
        v.version,
        seal(this.#key, value, aad, "job", orgId),
      );
      n++;
    }
    return n;
  }

  async delete(orgId: string, scope: SecretScopeInput): Promise<SecretView | undefined> {
    const sc = normalizeScope(scope);
    const existing = await findVaultSecret(
      this.#db,
      orgId,
      sc.name,
      scopeKeyOf(sc.projectId, sc.environment, sc.refPattern),
    );
    if (!existing) return undefined;
    const before = await this.#viewById(orgId, existing.id);
    await deleteVaultSecret(this.#db, orgId, existing.id);
    return before;
  }

  async list(
    orgId: string,
    projectId?: string,
    page: { afterId?: string; limit?: number } = {},
  ): Promise<SecretView[]> {
    const rows = await listVaultSecrets(
      this.#db,
      projectId ? { orgId, projectId } : { orgId },
      page,
    );
    const out: SecretView[] = [];
    for (const r of rows) out.push(view(r, await listVaultVersions(this.#db, orgId, r.id)));
    return out;
  }

  async #viewById(orgId: string, id: string): Promise<SecretView | undefined> {
    const row = await getVaultSecretById(this.#db, orgId, id);
    return row ? view(row, await listVaultVersions(this.#db, orgId, id)) : undefined;
  }

  /**
   * Whether some secret of this name, visible to the project, names this host as a destination.
   * A rule check only: it reads no value and says nothing about a run. `use` decides each real
   * delivery.
   */
  async canDeliver(orgId: string, projectId: string, name: string, host: string): Promise<boolean> {
    const candidates = (await vaultCandidates(this.#db, orgId, name)).filter(
      (c) => c.projectId === null || c.projectId === projectId,
    );
    return candidates.some((c) => hostAllowed(JSON.parse(c.destinations) as string[], host));
  }

  /**
   * The one policy decision. Returns the value only when every rule holds, and audits the
   * outcome either way (which run, job, attempt, destination; never the value).
   */
  async use(req: UseRequest): Promise<UseResult> {
    const scope = { orgId: req.orgId, projectId: req.projectId };
    const deny = async (reason: UseDenial, secretId?: string): Promise<UseResult> => {
      await auditFailure(
        this.#db,
        {
          orgId: req.orgId,
          principalKind: "attempt",
          principalId: req.attemptId,
          source: req.attemptId,
          kind: `secret_denied:${reason}`,
          op: "secret_use",
          outcome: `error:${reason}`,
          detail: {
            secret: req.name,
            ...(secretId ? { secret_id: secretId } : {}),
            run: req.runId,
            job: req.jobId,
            attempt: req.attemptId,
            destination: req.destination,
          },
        },
        this.#now,
      );
      return { ok: false, reason };
    };

    const run = await getRun(this.#db, scope, req.runId);
    const job = await getJob(this.#db, scope, req.jobId);
    const attempt = await getAttempt(this.#db, scope, req.attemptId);
    if (!run || !job || !attempt || job.runId !== run.id || attempt.jobId !== job.id) {
      return deny("unknown_run");
    }
    if (attempt.state !== "running") return deny("attempt_not_running");
    // Only what the scheduler recorded. A class the caller names, or a stored ceiling, is never
    // enough: the recorded one has the demotion rule applied.
    const klass = attempt.trustClass as TrustClass | null;
    if (!klass) return deny("class_unrecorded");
    if (klass === "untrusted_pr" || !credentialsFor(klass).secrets)
      return deny("class_not_allowed");
    // Publish credentials belong to the release lane alone, whatever the policy says below.
    if (klass === "release" && this.#lane !== "release") return deny("release_lane_only");

    const environment = jobEnvironment(job.planned);
    const ref = normalizeRef(run.ref);
    const matching = (await vaultCandidates(this.#db, req.orgId, req.name)).filter(
      (c) =>
        (c.projectId === null || c.projectId === req.projectId) &&
        (c.refPattern === null || matchesPatterns([c.refPattern], ref)),
    );
    // Environment cannot be established for a job yet: an environment-scoped secret is refused
    // rather than matched on a guess.
    const envOk = matching.filter((c) => c.environment === null || c.environment === environment);
    if (envOk.length === 0) {
      return deny(
        matching.some((c) => c.environment !== null && environment === null)
          ? "environment_unavailable"
          : "no_match",
      );
    }
    const score = (c: VaultSecretRow): number =>
      (c.projectId ? 4 : 0) + (c.environment ? 2 : 0) + (c.refPattern ? 1 : 0);
    const best = Math.max(...envOk.map(score));
    const top = envOk.filter((c) => score(c) === best);
    if (top.length > 1) return deny("ambiguous");
    const secret = top[0]!;

    const classes = JSON.parse(secret.trustClasses) as string[];
    if (classes.includes("untrusted_pr") || !classes.includes(klass)) {
      return deny("class_not_allowed", secret.id);
    }
    const hosts = JSON.parse(secret.destinations) as string[];
    if (!hostAllowed(hosts, req.destination)) return deny("destination_not_allowed", secret.id);

    const version = req.version ?? secret.currentVersion;
    const rec = await getVersionCiphertext(this.#db, req.orgId, secret.id, version);
    const now = this.#now();
    if (!rec || (version !== secret.currentVersion && (rec.validUntil ?? 0) <= now)) {
      return deny("version_unavailable", secret.id);
    }
    let value: string;
    try {
      value = open(
        this.#key,
        rec.ciphertext,
        vaultAad(req.orgId, secret.id, version, secret.name),
        "job",
        req.orgId,
      );
    } catch {
      return deny("decrypt_failed", secret.id);
    }
    await appendAudit(this.#db, scope, {
      principalKind: "attempt",
      principalId: req.attemptId,
      op: "secret_use",
      effect: "use",
      outcome: "ok",
      input: {
        secret: secret.name,
        secret_id: secret.id,
        version,
        run: req.runId,
        job: req.jobId,
        attempt: req.attemptId,
        destination: req.destination,
        class: klass,
      },
    });
    await touchVaultSecret(this.#db, req.orgId, secret.id, now);
    return { ok: true, value, version, secretId: secret.id };
  }

  /**
   * A publish credential for the release lane, with no job behind it: the lane itself is the
   * caller, so there is no run or attempt to take a class from. The same rules otherwise: only
   * the release lane (any other lane is refused before anything is decrypted), only a secret
   * whose allowed classes include `release`, scoped to the project and matching the tag's ref,
   * only for a destination it lists. Every use and every refusal is audited, never the value.
   */
  async usePublishCredential(req: PublishUseRequest): Promise<PublishUseResult> {
    const scope = { orgId: req.orgId, projectId: req.projectId };
    const deny = async (reason: UseDenial, secretId?: string): Promise<PublishUseResult> => {
      await auditFailure(
        this.#db,
        {
          orgId: req.orgId,
          principalKind: "system",
          principalId: "release-lane",
          source: req.requestId,
          kind: `secret_denied:${reason}`,
          op: "secret_use",
          outcome: `error:${reason}`,
          detail: {
            secret: req.name,
            ...(secretId ? { secret_id: secretId } : {}),
            request: req.requestId,
            tag: req.tag,
            destination: req.destination,
          },
        },
        this.#now,
      );
      return { ok: false, reason };
    };
    if (this.#lane !== "release") return deny("release_lane_only");
    const ref = normalizeRef(`refs/tags/${req.tag}`);
    const matching = (await vaultCandidates(this.#db, req.orgId, req.name)).filter(
      (c) =>
        (c.projectId === null || c.projectId === req.projectId) &&
        (c.refPattern === null || matchesPatterns([c.refPattern], ref)) &&
        // A publish credential has no job environment: one that names an environment is not for this.
        c.environment === null,
    );
    if (matching.length === 0) return deny("no_match");
    const score = (c: VaultSecretRow): number => (c.projectId ? 4 : 0) + (c.refPattern ? 1 : 0);
    const best = Math.max(...matching.map(score));
    const top = matching.filter((c) => score(c) === best);
    if (top.length > 1) return deny("ambiguous");
    const secret = top[0]!;
    const classes = JSON.parse(secret.trustClasses) as string[];
    if (classes.includes("untrusted_pr") || !classes.includes("release")) {
      return deny("class_not_allowed", secret.id);
    }
    const hosts = JSON.parse(secret.destinations) as string[];
    if (!hostAllowed(hosts, req.destination)) return deny("destination_not_allowed", secret.id);
    const version = secret.currentVersion;
    const rec = await getVersionCiphertext(this.#db, req.orgId, secret.id, version);
    if (!rec) return deny("version_unavailable", secret.id);
    let value: string;
    try {
      value = open(
        this.#key,
        rec.ciphertext,
        vaultAad(req.orgId, secret.id, version, secret.name),
        "job",
        req.orgId,
      );
    } catch {
      return deny("decrypt_failed", secret.id);
    }
    await appendAudit(this.#db, scope, {
      principalKind: "system",
      principalId: "release-lane",
      op: "secret_use",
      effect: "use",
      outcome: "ok",
      input: {
        secret: secret.name,
        secret_id: secret.id,
        version,
        request: req.requestId,
        tag: req.tag,
        destination: req.destination,
        class: "release",
      },
    });
    await touchVaultSecret(this.#db, req.orgId, secret.id, this.#now());
    return { ok: true, value, version, secretId: secret.id };
  }
}

export interface PublishUseRequest {
  orgId: string;
  projectId: string;
  /** The secret's name, as the project's publish target declares it. */
  name: string;
  /** The registry host the value goes to. Required: a use without a destination is refused. */
  destination: string;
  /** The tag being released: ref-scoped secrets are matched against `refs/tags/<tag>`. */
  tag: string;
  /** The lane's request id, for the audit trail. */
  requestId: string;
}

export type PublishUseResult =
  | { ok: true; value: string; version: number; secretId: string }
  | { ok: false; reason: UseDenial };

/** The environment a job runs in, if its plan records one. Today none does. */
function jobEnvironment(planned: string | null): string | null {
  if (!planned) return null;
  try {
    const e = (JSON.parse(planned) as { environment?: unknown }).environment;
    return typeof e === "string" && e !== "" ? e : null;
  } catch {
    return null;
  }
}

/** Exact host, or `*.suffix` matching any subdomain (not the bare suffix). Empty list: nothing. */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : p === h,
  );
}
