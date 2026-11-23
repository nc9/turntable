// How a name-folding filesystem compares paths. Shared by the checkout writer (which refuses to
// write through a symlink it made) and the tar scanner (which refuses two names that fold together).

/** Characters HFS+ ignores when comparing names, so `.g\u200cit` is `.git` there. */
/* oxlint-disable eslint/no-misleading-character-class -- these are single code points, listed on purpose */
export const HFS_IGNORABLE = /[\u200c\u200d\u200e\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/* oxlint-enable eslint/no-misleading-character-class */

/**
 * A path as a name-folding filesystem would compare it: each component in Unicode NFC (HFS+ and
 * APFS store and compare by normalisation form), without HFS-ignorable characters, lower-cased,
 * without trailing dots and spaces (NTFS). Two paths with the same key may be the same file.
 */
export function foldKey(path: string): string {
  return path
    .split("/")
    .map((c) =>
      c
        .normalize("NFC")
        .replaceAll(HFS_IGNORABLE, "")
        .toLowerCase()
        .replace(/[ .]+$/, ""),
    )
    .join("/");
}
