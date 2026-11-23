// `longshore token create --instance`: mints an instance-administrator token on the host. Like the
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
