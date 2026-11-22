// The secrets vault tables: scoped secret metadata and sealed versions. Like index.ts, part of
// the only code allowed to name tenant tables. A sealed value is returned only by
// getVersionCiphertext, for the vault service; every other query selects metadata.
import { and, asc, eq, gt } from "drizzle-orm";
import { ulid } from "../ulid";
import type { Db } from "..";
import * as s from "../schema";
import { type Scope, scoped } from "./scope";

export type VaultSecretRow = typeof s.vaultSecrets.$inferSelect;
export type VaultVersionMeta = Omit<typeof s.vaultSecretVersions.$inferSelect, "ciphertext">;

const SECRET_COLS = { orgId: s.vaultSecrets.orgId, projectId: s.vaultSecrets.projectId };

/** The normalised scope tuple; `*` for unset, so the unique index works with NULLs. */
export const scopeKeyOf = (
  projectId: string | null,
  environment: string | null,
  refPattern: string | null,
): string => `${projectId ?? "*"}|${environment ?? "*"}|${refPattern ?? "*"}`;

export interface NewVaultSecret {
  name: string;
  projectId: string | null;
  environment: string | null;
  refPattern: string | null;
  trustClasses: readonly string[];
  destinations: readonly string[];
  createdBy: string;
}

export function findVaultSecret(
  db: Db,
  orgId: string,
  name: string,
  scopeKey: string,
): Promise<VaultSecretRow | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.vaultSecrets)
      .where(
        and(
          eq(s.vaultSecrets.orgId, orgId),
          eq(s.vaultSecrets.name, name),
          eq(s.vaultSecrets.scopeKey, scopeKey),
        ),
      )
      .limit(1);
    return row;
  });
}

/** Every secret of that name in the org, whatever its scope: the candidates for a use. */
export function vaultCandidates(db: Db, orgId: string, name: string): Promise<VaultSecretRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.vaultSecrets)
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.name, name))),
  );
}

/** Metadata only, ascending by id (creation order), for cursor paging. */
export function listVaultSecrets(
  db: Db,
  scope: Scope,
  opts: { afterId?: string; limit?: number } = {},
): Promise<VaultSecretRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.vaultSecrets)
      .where(
        scoped(
          scope,
          SECRET_COLS,
          opts.afterId === undefined ? undefined : gt(s.vaultSecrets.id, opts.afterId),
        ),
      )
      .orderBy(asc(s.vaultSecrets.id))
      .limit(opts.limit ?? 1000),
  );
}

export function getVaultSecretById(
  db: Db,
  orgId: string,
  id: string,
): Promise<VaultSecretRow | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.vaultSecrets)
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.id, id)))
      .limit(1);
    return row;
  });
}

export function listVaultVersions(
  db: Db,
  orgId: string,
  secretId: string,
): Promise<VaultVersionMeta[]> {
  return db.run((h) =>
    h.orm
      .select({
        secretId: s.vaultSecretVersions.secretId,
        orgId: s.vaultSecretVersions.orgId,
        version: s.vaultSecretVersions.version,
        createdBy: s.vaultSecretVersions.createdBy,
        createdAt: s.vaultSecretVersions.createdAt,
        validUntil: s.vaultSecretVersions.validUntil,
      })
      .from(s.vaultSecretVersions)
      .where(
        and(eq(s.vaultSecretVersions.orgId, orgId), eq(s.vaultSecretVersions.secretId, secretId)),
      )
      .orderBy(asc(s.vaultSecretVersions.version)),
  );
}

/** The sealed record of one version. Only the vault service calls this. */
export function getVersionCiphertext(
  db: Db,
  orgId: string,
  secretId: string,
  version: number,
): Promise<{ ciphertext: string; validUntil: number | null } | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({
        ciphertext: s.vaultSecretVersions.ciphertext,
        validUntil: s.vaultSecretVersions.validUntil,
      })
      .from(s.vaultSecretVersions)
      .where(
        and(
          eq(s.vaultSecretVersions.orgId, orgId),
          eq(s.vaultSecretVersions.secretId, secretId),
          eq(s.vaultSecretVersions.version, version),
        ),
      )
      .limit(1);
    return row;
  });
}

/** Creates a secret with its first version. `seal` gets the new id so the id can be in the AAD. */
export function insertVaultSecret(
  db: Db,
  orgId: string,
  input: NewVaultSecret,
  seal: (secretId: string, version: number) => string,
): Promise<VaultSecretRow> {
  return db.transaction(async (tx) => {
    const id = ulid();
    const now = Date.now();
    const row = {
      id,
      orgId,
      projectId: input.projectId,
      name: input.name,
      environment: input.environment,
      refPattern: input.refPattern,
      scopeKey: scopeKeyOf(input.projectId, input.environment, input.refPattern),
      trustClasses: JSON.stringify(input.trustClasses),
      destinations: JSON.stringify(input.destinations),
      currentVersion: 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    await tx.orm.insert(s.vaultSecrets).values(row);
    await tx.orm.insert(s.vaultSecretVersions).values({
      secretId: id,
      orgId,
      version: 1,
      ciphertext: seal(id, 1),
      createdBy: input.createdBy,
      createdAt: now,
      validUntil: null,
    });
    return row;
  });
}

/**
 * Adds a version and makes it current. The previous current version stays usable until
 * `previousValidUntil` (rotation overlap); pass `now` to retire it at once. Optionally replaces
 * the policy fields in the same step. Returns the new version number.
 */
export function addVaultVersion(
  db: Db,
  orgId: string,
  secretId: string,
  opts: {
    createdBy: string;
    previousValidUntil: number;
    policy?: { trustClasses: readonly string[]; destinations: readonly string[] };
  },
  seal: (version: number) => string,
): Promise<number | undefined> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.orm
      .select({ v: s.vaultSecrets.currentVersion })
      .from(s.vaultSecrets)
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.id, secretId)))
      .limit(1);
    if (!cur) return undefined;
    const version = cur.v + 1;
    const now = Date.now();
    await tx.orm
      .update(s.vaultSecretVersions)
      .set({ validUntil: opts.previousValidUntil })
      .where(
        and(
          eq(s.vaultSecretVersions.orgId, orgId),
          eq(s.vaultSecretVersions.secretId, secretId),
          eq(s.vaultSecretVersions.version, cur.v),
        ),
      );
    await tx.orm.insert(s.vaultSecretVersions).values({
      secretId,
      orgId,
      version,
      ciphertext: seal(version),
      createdBy: opts.createdBy,
      createdAt: now,
      validUntil: null,
    });
    await tx.orm
      .update(s.vaultSecrets)
      .set({
        currentVersion: version,
        updatedAt: now,
        ...(opts.policy
          ? {
              trustClasses: JSON.stringify(opts.policy.trustClasses),
              destinations: JSON.stringify(opts.policy.destinations),
            }
          : {}),
      })
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.id, secretId)));
    return version;
  });
}

export function deleteVaultSecret(db: Db, orgId: string, secretId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.orm
      .delete(s.vaultSecretVersions)
      .where(
        and(eq(s.vaultSecretVersions.orgId, orgId), eq(s.vaultSecretVersions.secretId, secretId)),
      );
    const rows = await tx.orm
      .delete(s.vaultSecrets)
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.id, secretId)))
      .returning({ id: s.vaultSecrets.id });
    return rows.length > 0;
  });
}

export function touchVaultSecret(
  db: Db,
  orgId: string,
  secretId: string,
  at: number,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.vaultSecrets)
      .set({ lastUsedAt: at })
      .where(and(eq(s.vaultSecrets.orgId, orgId), eq(s.vaultSecrets.id, secretId)));
  });
}

/** Every sealed version of an org with its secret's name, for re-sealing. Vault service only. */
export function listVaultCiphertexts(
  db: Db,
  orgId: string,
): Promise<{ secretId: string; version: number; name: string; ciphertext: string }[]> {
  return db.run((h) =>
    h.orm
      .select({
        secretId: s.vaultSecretVersions.secretId,
        version: s.vaultSecretVersions.version,
        name: s.vaultSecrets.name,
        ciphertext: s.vaultSecretVersions.ciphertext,
      })
      .from(s.vaultSecretVersions)
      .innerJoin(
        s.vaultSecrets,
        and(
          eq(s.vaultSecrets.id, s.vaultSecretVersions.secretId),
          eq(s.vaultSecrets.orgId, s.vaultSecretVersions.orgId),
        ),
      )
      .where(eq(s.vaultSecretVersions.orgId, orgId)),
  );
}

/** Replaces one version's sealed record with the same value sealed another way. */
export function setVaultCiphertext(
  db: Db,
  orgId: string,
  secretId: string,
  version: number,
  ciphertext: string,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.vaultSecretVersions)
      .set({ ciphertext })
      .where(
        and(
          eq(s.vaultSecretVersions.orgId, orgId),
          eq(s.vaultSecretVersions.secretId, secretId),
          eq(s.vaultSecretVersions.version, version),
        ),
      );
  });
}
