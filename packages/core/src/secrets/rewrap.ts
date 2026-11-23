// Master key rotation with no shell: at boot, with the new key and the previous one, every sealed
// row is re-encrypted under the new key in ONE database transaction.
//
// Every place the master key seals something, found by the call sites of `seal`:
//   - `secrets`: the GitHub App credentials, the audit signing keys, the OIDC signing keys (the
//     `oidc` key domain, names `oidc/key/*`) and any other system secret;
//   - `vault_secret_versions`: the vault (the `job` domain);
//   - `outbound_secrets`: outbound webhook signing secrets (the `webhook` domain);
//   - the audit anchor state files (outside the database, so done around the transaction).
// Not covered: cache blobs (a cache: entries sealed under the old key stop opening and are
// misses), and the release lane's own state (sealed with the lane's key; see release/rewrap.ts).
// Two key families can be held: the main pair and the release lane's pair (alpha.1 runs the lane
// in-process, so both can be present). A row that allows the `release` class is tried under all
// four keys, and is re-wrapped under the new key of the family it opened under.
//
// Idempotent without a stored key id: each row is tried under the family's NEW key first (already
// re-wrapped: skipped), then its previous one. A row that opens under none of the held keys fails
// the whole run before anything is written, naming every such row. The one exception: the release
// keys are not in this process but a release lane is configured for the instance (a future split
// service), and the row allows `release`: it is counted and logged as left for the release service.
// Each re-sealed row is opened again under the new key and compared before the transaction commits.
import { eq, and } from "drizzle-orm";
import { AuditAnchor, AnchorCorrupt } from "../audit/anchor";
import type { Db } from "../db";
import { appendAudit } from "../db/repos";
import * as s from "../db/schema";
import { RELEASE_KEY_ENV } from "../roles";
import { webhookSecretAad } from "../webhooks/service";
import { type KeyDomain, open, SecretDecryptError, seal, secretAad, vaultAad } from "./crypto";

export interface RewrapCounts {
  secrets: number;
  vault_secret_versions: number;
  outbound_secrets: number;
  audit_anchor_files: number;
}

export interface RewrapResult {
  /** Rows re-sealed under the new key. */
  rewrapped: RewrapCounts;
  /** Rows that were already under the new key. */
  alreadyCurrent: RewrapCounts;
  /** Vault rows left for the release service: they allow `release`, open under neither main key, and the lane is configured elsewhere. */
  skipped: string[];
  /** Release-class vault rows re-sealed under the new release key (also counted in `rewrapped`). */
  releaseRewrapped: number;
}

/** The rewrap failed and nothing was changed. The message names the table and row, never a value. */
export class RewrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewrapError";
  }
}

const zero = (): RewrapCounts => ({
  secrets: 0,
  vault_secret_versions: 0,
  outbound_secrets: 0,
  audit_anchor_files: 0,
});

/** The key domain a `secrets` row is sealed in: OIDC keys have their own, the rest are `system`. */
const secretDomain = (name: string): KeyDomain =>
  name.startsWith("oidc/key/") ? "oidc" : "system";

interface Planned<T> {
  row: T;
  sealed: string;
}

/** A family of keys: the one rows are sealed under now, and the one they were sealed under before. */
export interface KeyPair {
  next: Buffer;
  previous?: Buffer | undefined;
}

/**
 * The new record for one row, or undefined when it is already under the new key. Throws
 * SecretDecryptError when the row opens under neither key of the pair.
 */
export function replan(
  keys: KeyPair,
  record: string,
  aad: Buffer,
  domain: KeyDomain,
  orgId: string | undefined,
): string | undefined {
  // Old formats are not forced open: with TURNTABLE_REQUIRE_ORG_KEYS=1 an old-format row is refused here as
  // everywhere else (run `keys reseal` first); without it old formats open as usual.
  try {
    open(keys.next, record, aad, domain, orgId);
    return undefined;
  } catch {
    // not under the new key: try the previous one
  }
  if (!keys.previous) throw new SecretDecryptError();
  const value = open(keys.previous, record, aad, domain, orgId);
  const sealed = seal(keys.next, value, aad, domain, orgId);
  // Verified here, before anything is written: it opens under the new key to the same value.
  if (open(keys.next, sealed, aad, domain, orgId) !== value) throw new SecretDecryptError();
  return sealed;
}

export interface RewrapOptions {
  db: Db;
  next: Buffer;
  /** The key the main rows were sealed under before a rotation. Absent when only the release pair rotates. */
  previous?: Buffer | undefined;
  /** The release lane's keys, when this process holds them (the lane runs in-process). */
  release?: KeyPair | undefined;
  /**
   * The release keys are not in this process but a release lane is configured for the instance
   * (a split service): release-class rows that open under neither main key are left for it.
   */
  releaseElsewhere?: boolean | undefined;
  /** Directory of the audit anchor state files, when there is one. */
  anchorDir?: string;
  /**
   * Read-only check: nothing is written and nothing is audited. With no `previous` and no release
   * keys, it throws RewrapError unless every row already opens under `next`.
   */
  dryRun?: boolean;
  /** Org whose chain takes the audit entry (the system org). */
  auditOrgId: string;
  log?: (m: string) => void;
}

/**
 * Re-encrypts everything sealed under `previous` so it is sealed under `next`. All database rows
 * change in one transaction (and so does the audit entry saying how many), or none do. Throws
 * RewrapError on any row that opens under neither key.
 */
export async function rewrapMasterKey(o: RewrapOptions): Promise<RewrapResult> {
  const keys: KeyPair = { next: o.next, previous: o.previous };
  const rewrapped = zero();
  let releaseRewrapped = 0;
  const failed: string[] = [];
  const alreadyCurrent = zero();
  const skipped: string[] = [];
  const where = (table: string, id: string): string => `${table} ${id}`;
  const plan = async <T>(
    table: keyof RewrapCounts,
    rows: T[],
    one: (r: T) => { id: string; record: string; aad: Buffer; domain: KeyDomain; orgId: string },
    allowsRelease?: (r: T) => boolean,
  ): Promise<Planned<T>[]> => {
    const out: Planned<T>[] = [];
    for (const row of rows) {
      const r = one(row);
      const release = allowsRelease?.(row) ?? false;
      let sealed: string | undefined;
      let viaRelease = false;
      try {
        sealed = replan(keys, r.record, r.aad, r.domain, r.orgId);
      } catch {
        // Not under a main key. A release-class row may be under a release key.
        let opened = false;
        if (release && o.release) {
          try {
            sealed = replan(o.release, r.record, r.aad, r.domain, r.orgId);
            viaRelease = opened = true;
          } catch {
            // under none of the keys held
          }
        }
        if (!opened) {
          if (release && !o.release && o.releaseElsewhere) {
            skipped.push(where(table, r.id));
          } else {
            failed.push(release ? `${where(table, r.id)} (allows release)` : where(table, r.id));
          }
          continue;
        }
      }
      if (sealed === undefined) alreadyCurrent[table]++;
      else {
        out.push({ row, sealed });
        if (viaRelease) releaseRewrapped++;
      }
    }
    return out;
  };

  // The anchor files first, read only: a file that opens under neither key stops the run before
  // the database is touched.
  const anchorPlan: { orgId: string; state: ReturnType<AuditAnchor["read"]> }[] = [];
  const cur = o.anchorDir ? new AuditAnchor(o.anchorDir, o.next) : undefined;
  const old = o.anchorDir && o.previous ? new AuditAnchor(o.anchorDir, o.previous) : undefined;
  for (const orgId of cur?.orgIds() ?? []) {
    try {
      cur!.read(orgId);
      alreadyCurrent.audit_anchor_files++;
      continue;
    } catch (e) {
      if (!(e instanceof AnchorCorrupt)) throw e;
    }
    try {
      if (!old) throw new Error("no previous key");
      anchorPlan.push({ orgId, state: old.read(orgId) });
    } catch {
      throw new RewrapError(
        `cannot re-wrap audit_anchor_files ${orgId}: it opens under neither the current nor the previous master key. Nothing was changed.`,
      );
    }
  }

  await o.db.transaction(async (tx) => {
    // A retried transaction (Postgres serialization) starts from clean counts.
    skipped.length = 0;
    failed.length = 0;
    releaseRewrapped = 0;
    for (const k of Object.keys(rewrapped) as (keyof RewrapCounts)[]) {
      rewrapped[k] = 0;
      if (k !== "audit_anchor_files") alreadyCurrent[k] = 0;
    }
    const secretRows = await plan(
      "secrets",
      await tx.orm
        .select({ orgId: s.secrets.orgId, name: s.secrets.name, ciphertext: s.secrets.ciphertext })
        .from(s.secrets),
      (r) => ({
        id: `${r.orgId}/${r.name}`,
        record: r.ciphertext,
        aad: secretAad(r.orgId, r.name),
        domain: secretDomain(r.name),
        orgId: r.orgId,
      }),
    );
    const vaultRows = await plan(
      "vault_secret_versions",
      await tx.orm
        .select({
          orgId: s.vaultSecretVersions.orgId,
          secretId: s.vaultSecretVersions.secretId,
          version: s.vaultSecretVersions.version,
          name: s.vaultSecrets.name,
          trustClasses: s.vaultSecrets.trustClasses,
          ciphertext: s.vaultSecretVersions.ciphertext,
        })
        .from(s.vaultSecretVersions)
        .innerJoin(
          s.vaultSecrets,
          and(
            eq(s.vaultSecrets.id, s.vaultSecretVersions.secretId),
            eq(s.vaultSecrets.orgId, s.vaultSecretVersions.orgId),
          ),
        ),
      (r) => ({
        id: `${r.orgId}/${r.secretId}@${r.version}`,
        record: r.ciphertext,
        aad: vaultAad(r.orgId, r.secretId, r.version, r.name),
        domain: "job",
        orgId: r.orgId,
      }),
      (r) => (JSON.parse(r.trustClasses) as string[]).includes("release"),
    );
    const hookRows = await plan(
      "outbound_secrets",
      await tx.orm
        .select({
          orgId: s.outboundSecrets.orgId,
          version: s.outboundSecrets.version,
          sealed: s.outboundSecrets.sealed,
        })
        .from(s.outboundSecrets),
      (r) => ({
        id: `${r.orgId}@${r.version}`,
        record: r.sealed,
        aad: webhookSecretAad(r.orgId, r.version),
        domain: "webhook",
        orgId: r.orgId,
      }),
    );
    if (failed.length > 0) {
      const releaseRows = failed.some((f) => f.endsWith("(allows release)"));
      throw new RewrapError(
        `cannot re-wrap ${failed.length} row${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}. ${failed.length === 1 ? "It opens" : "They open"} under none of the master keys held. ${releaseRows ? `Provide the release master key (${RELEASE_KEY_ENV}[_PREVIOUS]) too, or the previous main key if it is missing. ` : "Check that the previous master key is the one these rows were sealed under. "}Nothing was changed.`,
      );
    }
    if (o.dryRun) return;
    for (const { row, sealed } of secretRows) {
      await tx.orm
        .update(s.secrets)
        .set({ ciphertext: sealed })
        .where(and(eq(s.secrets.orgId, row.orgId), eq(s.secrets.name, row.name)));
      rewrapped.secrets++;
    }
    for (const { row, sealed } of vaultRows) {
      await tx.orm
        .update(s.vaultSecretVersions)
        .set({ ciphertext: sealed })
        .where(
          and(
            eq(s.vaultSecretVersions.orgId, row.orgId),
            eq(s.vaultSecretVersions.secretId, row.secretId),
            eq(s.vaultSecretVersions.version, row.version),
          ),
        );
      rewrapped.vault_secret_versions++;
    }
    for (const { row, sealed } of hookRows) {
      await tx.orm
        .update(s.outboundSecrets)
        .set({ sealed })
        .where(
          and(eq(s.outboundSecrets.orgId, row.orgId), eq(s.outboundSecrets.version, row.version)),
        );
      rewrapped.outbound_secrets++;
    }
    const total = rewrapped.secrets + rewrapped.vault_secret_versions + rewrapped.outbound_secrets;
    if (total + anchorPlan.length > 0) {
      await appendAudit(
        tx,
        { orgId: o.auditOrgId },
        {
          principalKind: "system",
          principalId: "boot",
          op: "master_key_rewrap",
          effect: "write",
          outcome: "ok",
          input: {
            secrets: rewrapped.secrets,
            vault_secret_versions: rewrapped.vault_secret_versions,
            outbound_secrets: rewrapped.outbound_secrets,
            audit_anchor_files: anchorPlan.length,
            ...(releaseRewrapped > 0 ? { release_key_rows: releaseRewrapped } : {}),
          },
        },
      );
    }
  });

  if (o.dryRun) return { rewrapped, alreadyCurrent, skipped, releaseRewrapped };

  // Committed. The anchor files are atomic renames, checked by reading back; a crash before they
  // finish is repaired by the next boot (they open under the previous key, so they are planned again).
  for (const { orgId, state } of anchorPlan) {
    if (!state) continue;
    cur!.write(
      orgId,
      { keyId: state.keyId, lastSeq: state.lastSeq, lastHash: state.lastHash },
      state.updatedAt,
    );
    const back = cur!.read(orgId);
    if (back?.lastSeq !== state.lastSeq || back.lastHash !== state.lastHash) {
      throw new RewrapError(`audit_anchor_files ${orgId} did not verify after the re-wrap`);
    }
    rewrapped.audit_anchor_files++;
  }
  o.log?.(
    `master key re-wrap: re-sealed ${rewrapped.secrets} secrets, ${rewrapped.vault_secret_versions} vault versions, ${rewrapped.outbound_secrets} webhook secrets, ${rewrapped.audit_anchor_files} audit anchor files (${releaseRewrapped} of the vault versions under the release key); ${alreadyCurrent.secrets + alreadyCurrent.vault_secret_versions + alreadyCurrent.outbound_secrets + alreadyCurrent.audit_anchor_files} already under the new key`,
  );
  if (skipped.length > 0) {
    o.log?.(
      `master key re-wrap: left ${skipped.length} release-class vault rows for the release service (they open under neither main key and the release keys are not in this process): ${skipped.join(", ")}`,
    );
  }
  return { rewrapped, alreadyCurrent, skipped, releaseRewrapped };
}
