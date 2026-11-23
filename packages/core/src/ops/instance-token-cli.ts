// `turntable token create --instance`: mints an instance-administrator token on the host. Like the
// org token CLI, local access to the data directory is the trust root, so this writes through the
// repos directly: no network, no principal, and no org or op can do it. The secret is shown once;
// only its hash is kept. Audited in the system org's chain.
import { systemOrgId } from "../audit/failures";
import type { Db } from "../db";
import {
  appendAudit,
  getInstanceToken,
  insertInstanceToken,
  listInstanceTokens,
  revokeInstanceToken,
} from "../db/repos";
import { generateInstanceToken, hashToken } from "./tokens";

const DAY_MS = 86_400_000;

export async function createInstanceTokenFromCli(
  db: Db,
  opts: { name: string; expiresInDays?: number | undefined; now?: (() => number) | undefined },
): Promise<{ id: string; secret: string; expiresAt: number }> {
  const name = opts.name.trim();
  if (name.length === 0 || name.length > 80) throw new Error("--name must be 1 to 80 characters");
  const days = opts.expiresInDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("--expires-days must be an integer from 1 to 90 for an instance token");
  }
  const secret = generateInstanceToken();
  const expiresAt = (opts.now ?? Date.now)() + days * DAY_MS;
  const orgId = await systemOrgId(db);
  const row = await db.transaction(async (tx) => {
    const created = await insertInstanceToken(tx, {
      name,
      tokenHash: hashToken(secret),
      createdBy: "cli:local",
      expiresAt,
    });
    await appendAudit(
      tx,
      { orgId },
      {
        principalKind: "cli",
        principalId: "local",
        op: "create_instance_token",
        effect: "write",
        outcome: "ok",
        input: { id: created.id, name, expires_in_days: days },
      },
    );
    return created;
  });
  return { id: row.id, secret, expiresAt };
}

export async function listInstanceTokensFromCli(
  db: Db,
  now: () => number = Date.now,
): Promise<
  {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number | null;
    status: "active" | "revoked" | "expired";
  }[]
> {
  const t = now();
  return (await listInstanceTokens(db)).map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    status:
      r.revokedAt !== null
        ? "revoked"
        : r.expiresAt !== null && r.expiresAt <= t
          ? "expired"
          : "active",
  }));
}

export async function revokeInstanceTokenFromCli(
  db: Db,
  id: string,
  now: () => number = Date.now,
): Promise<{ id: string; name: string }> {
  const row = await getInstanceToken(db, id);
  if (!row) throw new Error(`no instance token ${id}`);
  const orgId = await systemOrgId(db);
  await db.transaction(async (tx) => {
    await revokeInstanceToken(tx, id, now());
    await appendAudit(
      tx,
      { orgId },
      {
        principalKind: "cli",
        principalId: "local",
        op: "revoke_instance_token",
        effect: "write",
        outcome: "ok",
        input: { id, name: row.name },
      },
    );
  });
  return { id, name: row.name };
}

/**
 * Rotation (#330): mints a new instance token and revokes the old one, together. The new secret
 * is returned once and only its hash is kept. The caller audits (the CLI here, the dispatcher for
 * the REST op) and supplies the transaction, so the pair is never half done.
 */
export async function rotateInstanceToken(
  db: Db,
  opts: {
    oldId: string;
    name?: string | undefined;
    expiresInDays?: number | undefined;
    createdBy: string;
    now?: (() => number) | undefined;
  },
): Promise<{ id: string; secret: string; expiresAt: number; revokedId: string }> {
  const days = opts.expiresInDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error("--expires-days must be an integer from 1 to 90 for an instance token");
  }
  const now = (opts.now ?? Date.now)();
  const old = await getInstanceToken(db, opts.oldId);
  if (!old) throw new Error(`no instance token ${opts.oldId}`);
  if (old.revokedAt !== null) throw new Error(`instance token ${opts.oldId} is already revoked`);
  const name = (opts.name ?? old.name).trim();
  if (name.length === 0 || name.length > 80) throw new Error("name must be 1 to 80 characters");
  const secret = generateInstanceToken();
  const expiresAt = now + days * DAY_MS;
  const created = await insertInstanceToken(db, {
    name,
    tokenHash: hashToken(secret),
    createdBy: opts.createdBy,
    expiresAt,
  });
  await revokeInstanceToken(db, old.id, now);
  return { id: created.id, secret, expiresAt, revokedId: old.id };
}

export async function rotateInstanceTokenFromCli(
  db: Db,
  opts: {
    oldId: string;
    name?: string | undefined;
    expiresInDays?: number | undefined;
    now?: (() => number) | undefined;
  },
): Promise<{ id: string; secret: string; expiresAt: number; revokedId: string }> {
  const orgId = await systemOrgId(db);
  return db.transaction(async (tx) => {
    const r = await rotateInstanceToken(tx, { ...opts, createdBy: "cli:local" });
    await appendAudit(
      tx,
      { orgId },
      {
        principalKind: "cli",
        principalId: "local",
        op: "rotate_instance_token",
        effect: "write",
        outcome: "ok",
        input: { id: r.id, revoked_id: r.revokedId },
      },
    );
    return r;
  });
}
