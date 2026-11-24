// The file names `db_backup` writes under `<data-dir>/backups/`. One module, no imports, so the
// root-start chown (privileges.ts) and the backup code share the same patterns and cannot drift.

export const BACKUPS_DIR = "backups";

/** `turntable-<time>-<version>[-<label>].db`. The time prefix makes names sort oldest first. */
export const BACKUP_NAME_RE = /^turntable-\d{8}T\d{9}Z-[A-Za-z0-9._-]+\.db$/;

/** The temp name while a copy is in progress: `.<backup name>.partial`. */
export const BACKUP_PARTIAL_RE = /^\.turntable-\d{8}T\d{9}Z-[A-Za-z0-9._-]+\.db\.partial$/;

/** True for a name `db_backup` writes, finished or in progress. */
export function isBackupEntryName(name: string): boolean {
  return BACKUP_NAME_RE.test(name) || BACKUP_PARTIAL_RE.test(name);
}

/** Names that are safe in a file name: the version of a build is not always plain semver. */
export function safePart(s: string, fallback: string): string {
  const cleaned = s.replaceAll(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return cleaned.slice(0, 40) || fallback;
}

/** The final file name for a backup taken at `createdAt` (ms) by `version`, with an optional label. */
export function backupFileName(createdAt: number, version: string, label?: string): string {
  const stamp = new Date(createdAt).toISOString().replaceAll(/[-:]/g, "").replace(".", "");
  const suffix = label === undefined ? "" : `-${safePart(label, "x")}`;
  return `turntable-${stamp}-${safePart(version, "unknown")}${suffix}.db`;
}

/** The temp name the copy is written under before it is renamed to `name`. */
export function backupPartialName(name: string): string {
  return `.${name}.partial`;
}
