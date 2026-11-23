// First-boot instance-administrator access without a shell (#330). The image is distroless, so
// `token create --instance` cannot run inside it. The operator generates a `tti_` token offline
// (`turntable token generate --instance`), keeps it, and sets only its sha256 as
// TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256. On boot, an instance with no unrevoked instance token
// gets one row with that hash. The secret never touches the environment or the logs, and neither
// does the hash: this module returns ids and times only.
//
// An instance token holds no org grant and has no `kind` column: it is minted by the operator on
// the host (or by this boot hook), never by an agent, so it is the person-kind equivalent.
import { systemOrgId } from "../audit/failures";
import type { Db } from "../db";
import {
  appendAudit,
  findInstanceTokenByHash,
  insertInstanceToken,
  listInstanceTokens,
} from "../db/repos";

const DAY_MS = 86_400_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The longest a bootstrap token lives. The expiry setting can lower this, never raise it. */
export const BOOTSTRAP_MAX_EXPIRY_DAYS = 30;

export const BOOTSTRAP_ENV = "TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256";
export const BOOTSTRAP_EXPIRY_ENV = "TURNTABLE_INSTANCE_BOOTSTRAP_EXPIRY_DAYS";

export type InstanceBootstrapResult =
  | { status: "created"; tokenId: string; expiresAt: number }
  | { status: "skipped"; reason: "an instance token exists" | "hash already used and revoked" };

/** Parses the expiry variable. Unset is the maximum; anything outside 1..30 stops the boot. */
export function bootstrapExpiryDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return BOOTSTRAP_MAX_EXPIRY_DAYS;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > BOOTSTRAP_MAX_EXPIRY_DAYS) {
    throw new Error(
      `${BOOTSTRAP_EXPIRY_ENV} must be an integer from 1 to ${BOOTSTRAP_MAX_EXPIRY_DAYS}`,
    );
  }
  return n;
}

export async function bootstrapInstanceToken(
  db: Db,
  opts: { sha256: string; expiresInDays?: number | undefined; now?: (() => number) | undefined },
): Promise<InstanceBootstrapResult> {
  const hash = opts.sha256.trim().toLowerCase();
  // The message never repeats the value: a token pasted here by mistake must not reach a log.
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`${BOOTSTRAP_ENV} must be 64 hex characters (the sha256 of a tti_ token)`);
  }
  const days = opts.expiresInDays ?? BOOTSTRAP_MAX_EXPIRY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > BOOTSTRAP_MAX_EXPIRY_DAYS) {
    throw new Error(
      `${BOOTSTRAP_EXPIRY_ENV} must be an integer from 1 to ${BOOTSTRAP_MAX_EXPIRY_DAYS}`,
    );
  }
  // Unrevoked, not unexpired: an expired token that was never revoked still counts, so a restart
  // cannot quietly hand a fresh credential to whoever holds the env var.
  const existing = (await listInstanceTokens(db)).some((r) => r.revokedAt === null);
  if (existing) return { status: "skipped", reason: "an instance token exists" };
  // The same hash is the same row. A revoked row is never brought back.
  if (await findInstanceTokenByHash(db, hash)) {
    return { status: "skipped", reason: "hash already used and revoked" };
  }
  const expiresAt = (opts.now ?? Date.now)() + days * DAY_MS;
  const orgId = await systemOrgId(db);
  try {
    const row = await db.transaction(async (tx) => {
      const created = await insertInstanceToken(tx, {
        name: "bootstrap",
        tokenHash: hash,
        createdBy: "bootstrap:env",
        expiresAt,
      });
      await appendAudit(
        tx,
        { orgId },
        {
          principalKind: "bootstrap",
          principalId: "env",
          op: "instance_bootstrap_token_registered",
          effect: "write",
          outcome: "ok",
          input: {
            id: created.id,
            name: "bootstrap",
            expires_in_days: days,
            source: BOOTSTRAP_ENV,
          },
        },
      );
      return created;
    });
    return { status: "created", tokenId: row.id, expiresAt };
  } catch (err) {
    // Two servers booting at once: the unique hash index lets one win.
    if (await findInstanceTokenByHash(db, hash)) {
      return { status: "skipped", reason: "an instance token exists" };
    }
    throw err;
  }
}
