// First-boot creation of the master key file, for a platform with no shell (Railway) where
// `longshore keys init` cannot be run. Opt in only (LONGSHORE_MASTER_KEY_AUTOINIT=1 or
// --init-master-key): without it, an absent key file is an error exactly as before.
//
// The file is created once and never overwritten. It is written complete to a private temporary
// file and then linked into place: `link` fails if the name exists, so of two replicas starting
// together exactly one creates it, and the other sees a whole file, never a partial one.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const KEY_BYTES = 32;
const OTHERS = 0o007;

export type AutoInit = "created" | "exists";

export class AutoInitRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoInitRefused";
  }
}

/** True when the variable or flag turns first-boot creation on. */
export const autoInitRequested = (
  env: Record<string, string | undefined>,
  flag: boolean | undefined,
): boolean => flag === true || env.LONGSHORE_MASTER_KEY_AUTOINIT?.trim() === "1";

/**
 * A directory that other users can read, list or write would expose where the key lives, and a
 * writable one lets another user swap the file. One we own is tightened (and the log says so); one
 * we do not own cannot be fixed from here, so creation is refused.
 */
function requirePrivateDir(dir: string, log: (m: string) => void): void {
  const st = statSync(dir);
  if ((st.mode & OTHERS) === 0) return;
  if (typeof process.getuid === "function" && st.uid === process.getuid()) {
    chmodSync(dir, st.mode & ~OTHERS);
    log(
      `tightened ${dir} to mode ${(st.mode & ~OTHERS & 0o777).toString(8)} (it was readable by other users)`,
    );
    return;
  }
  throw new AutoInitRefused(
    `refusing to create the master key: ${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}) and is not owned by this process, so it cannot be tightened`,
  );
}

/**
 * Creates the master key file at `path` if it is absent. Returns "exists" and touches nothing when
 * it is there. `dataDir` is checked as well as the key's own directory. Logs the path only.
 */
export function autoInitMasterKey(
  path: string,
  dataDir: string,
  log: (m: string) => void = () => {},
): AutoInit {
  if (existsSync(path)) return "exists";
  const dir = dirname(path);
  // A directory we create is private from the start.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requirePrivateDir(dir, log);
  if (existsSync(dataDir)) requirePrivateDir(dataDir, log);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(KEY_BYTES));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    try {
      linkSync(tmp, path);
    } catch (e) {
      // Another replica won the race: use its file.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw e;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  log(`created master key file ${path} (mode 0600); back it up separately from the volume`);
  return "created";
}
