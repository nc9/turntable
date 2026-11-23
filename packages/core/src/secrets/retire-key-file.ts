// Retires the old master key FILE from the volume with no shell: a one-shot boot flag,
// TURNTABLE_MASTER_KEY_RETIRE_FILE=<path>. After any re-wrap, the file is deleted only if ALL hold:
//   1. the process runs on TURNTABLE_MASTER_KEY (the env key), not on a file;
//   2. every sealed row opens under the current key (the re-wrap's own check, read-only);
//   3. the file's key equals the previous key given this boot (compared in constant time);
//   4. the path is a regular file (no symlink) inside the data directory.
// Otherwise one log line names the condition that failed and the file is left. A file that is
// already gone logs once and changes nothing. A success is audited as `master_key_file_retired`
// (the path, never a key).
import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "../db";
import { appendAudit } from "../db/repos";
import { type MasterKeys, PREVIOUS_KEY_ENV, PREVIOUS_KEY_FILE_ENV } from "./master-key";
import { rewrapMasterKey } from "./rewrap";

export const RETIRE_FILE_ENV = "TURNTABLE_MASTER_KEY_RETIRE_FILE";

export type RetireOutcome =
  { retired: true } | { retired: false; reason: "gone" | "refused"; condition?: 1 | 2 | 3 | 4 };

export interface RetireOptions {
  db: Db;
  /** The value of TURNTABLE_MASTER_KEY_RETIRE_FILE. */
  path: string;
  dataDir: string;
  keys: MasterKeys;
  anchorDir: string;
  auditOrgId: string;
  log: (m: string) => void;
}

const KEY_BYTES = 32;

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/** Runs the four checks and deletes the file when all pass. Never throws for a refusal. */
export async function retireMasterKeyFile(o: RetireOptions): Promise<RetireOutcome> {
  const refuse = (condition: 1 | 2 | 3 | 4, why: string): RetireOutcome => {
    o.log(
      `${RETIRE_FILE_ENV}: refused, condition ${condition} failed (${why}); the file was left in place`,
    );
    return { retired: false, reason: "refused", condition };
  };
  // 1. Running on the env key.
  if (o.keys.source !== "env") {
    return refuse(1, "the process runs on a master key file, not TURNTABLE_MASTER_KEY");
  }
  const path = resolve(o.path);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      o.log(`${RETIRE_FILE_ENV}: ${o.path} is already gone; remove the variable`);
      return { retired: false, reason: "gone" };
    }
    return refuse(4, "the path cannot be read");
  }
  // 4. A regular file, not a link, inside the data directory (its parent resolved too).
  if (st.isSymbolicLink()) return refuse(4, "the path is a symlink");
  if (!st.isFile()) return refuse(4, "the path is not a regular file");
  let root: string;
  let parent: string;
  try {
    root = realpathSync(o.dataDir);
    parent = realpathSync(dirname(path));
  } catch {
    return refuse(4, "the path cannot be resolved");
  }
  if (!inside(root, join(parent, basename(path)))) {
    return refuse(4, "the path is outside the data directory");
  }
  // 3. The file's key is the previous key given this boot.
  const previous = o.keys.previous;
  if (!previous) {
    return refuse(
      3,
      `no previous key was given (${PREVIOUS_KEY_ENV} or ${PREVIOUS_KEY_FILE_ENV}), or it equals the current key`,
    );
  }
  let fileKey: Buffer;
  try {
    fileKey = readFileSync(join(parent, basename(path)));
  } catch {
    return refuse(4, "the file cannot be read");
  }
  if (
    fileKey.length !== KEY_BYTES ||
    previous.length !== KEY_BYTES ||
    !timingSafeEqual(fileKey, previous)
  ) {
    return refuse(3, "the file is not the previous key given this boot");
  }
  // 2. Every sealed row opens under the current key alone.
  try {
    await rewrapMasterKey({
      db: o.db,
      next: o.keys.key,
      anchorDir: o.anchorDir,
      auditOrgId: o.auditOrgId,
      dryRun: true,
    });
  } catch (e) {
    return refuse(2, `not every sealed row opens under the current key: ${(e as Error).message}`);
  }
  // Delete, then make the removal durable.
  const real = join(parent, basename(path));
  unlinkSync(real);
  const fd = openSync(parent, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  await appendAudit(
    o.db,
    { orgId: o.auditOrgId },
    {
      principalKind: "system",
      principalId: "boot",
      op: "master_key_file_retired",
      effect: "write",
      outcome: "ok",
      input: { path: real },
    },
  );
  o.log(`${RETIRE_FILE_ENV}: deleted ${real}; remove the variable and the previous key`);
  return { retired: true };
}
