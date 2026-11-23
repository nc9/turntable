import type { Migration } from "./migrate";

/** sha256 of a migration's SQL: the statements as a JSON array, so no separator can collide. */
export function migrationSha(migration: Migration): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(migration.statements)).digest("hex");
}

/**
 * Migrations edited in place after a database may have applied them. A released migration is
 * immutable and fixes go in a new migration, so this list only ever names edits made before that
 * rule. `shas` are the earlier hashes of the SQL that databases may have recorded; those are
 * accepted instead of refusing to boot. Every entry needs a reason.
 */
export const EDITED_IN_PLACE: Record<string, { shas: string[]; reason: string }> = {
  "0033_outbound_webhooks": {
    shas: ["be7936db77a3268fc4064c62e3b5d96509a8e4d91a67f664ec62042f7f331e94"],
    reason:
      "#275 edited the SQLite SQL to keep the events AUTOINCREMENT high-water mark. A database that applied the earlier text keeps its tables as they are.",
  },
};

/**
 * Compares the hash recorded for each applied migration with the current SQL and throws on a
 * mismatch. `recorded` maps tag to the stored hash, or null for a row from before hashes were
 * kept. Returns the rows to backfill (null hash, tag still in the list), which are stamped with
 * the current hash: that is the best available, since the original SQL is not known.
 */
export function checkMigrationShas(
  recorded: Map<string, string | null>,
  list: Migration[],
  allowed: Record<string, { shas: string[]; reason: string }> = EDITED_IN_PLACE,
): { tag: string; sha: string }[] {
  const backfill: { tag: string; sha: string }[] = [];
  for (const migration of list) {
    if (!recorded.has(migration.tag)) continue;
    const stored = recorded.get(migration.tag) ?? null;
    const current = migrationSha(migration);
    if (stored === null) backfill.push({ tag: migration.tag, sha: current });
    else if (stored !== current && !allowed[migration.tag]?.shas.includes(stored)) {
      throw new Error(
        `migration ${migration.tag} was applied with different SQL than this build has ` +
          `(recorded sha256 ${stored}, current ${current}). A released migration is immutable: ` +
          `restore its SQL and put the change in a new migration. Refusing to start.`,
      );
    }
  }
  return backfill;
}
