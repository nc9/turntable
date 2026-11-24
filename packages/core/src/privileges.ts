// Running as root, and getting out of it. Some platforms (Railway) mount volumes owned by root,
// which a non-root image cannot write. The image therefore starts as root, and with
// TURNTABLE_DROP_PRIVILEGES=<uid>:<gid> the server takes ownership of the files it expects in its
// data directory and drops to that user BEFORE it opens anything else: no database, no key file,
// no socket is ever touched as root. A server that is still root after startup is refused unless
// the operator said TURNTABLE_ALLOW_ROOT=1.
//
// Two things here are deliberately strict, because root is doing the work:
//  - the chown never walks an arbitrary tree. Something the old non-root process could create
//    (a symlink, or a hardlink to /etc/shadow, which IS that file) must never be handed to the
//    service user, so only the names Turntable itself writes are touched, each through an open
//    file descriptor opened without following links, and anything unexpected stops the start;
//  - every step of the drop is checked, and a platform that cannot do one refuses to run.
import { basename, dirname, join, resolve } from "node:path";
import {
  closeSync,
  constants,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { BACKUPS_DIR, isBackupEntryName } from "./db/backup-names";

export class RootRefused extends Error {}

/** What the policy needs from the process, so tests can watch the order of the calls. */
export interface PrivilegeOps {
  uid(): number;
  gid(): number;
  groups(): number[];
  chownData(dataDir: string, uid: number, gid: number, env: Env): void;
  setgroups(groups: number[]): void;
  setgid(gid: number): void;
  setuid(uid: number): void;
}

type Env = Record<string, string | undefined>;

/** `uid:gid`, both whole numbers, neither root. */
export function parseDropSpec(spec: string): { uid: number; gid: number } {
  const m = /^(\d{1,10}):(\d{1,10})$/.exec(spec.trim());
  if (!m) throw new Error("TURNTABLE_DROP_PRIVILEGES must be <uid>:<gid>, for example 65532:65532");
  const uid = Number(m[1]);
  const gid = Number(m[2]);
  if (uid === 0 || gid === 0)
    throw new Error("TURNTABLE_DROP_PRIVILEGES cannot name root (uid or gid 0)");
  return { uid, gid };
}

/** The files Turntable writes in its data directory: the database, as the current or old name. */
const DB_FILE = /^(turntable|longshore)\.db(-wal|-shm|-journal)?$/; // rename-keep
/** What a volume brings itself; left alone, never chowned. */
const SKIP = new Set(["lost+found"]);

/** The names a data directory may hold, given where the master key file lives. */
export interface Expected {
  /** Regular files, by name. */
  files: Set<string>;
  /** Directories whose own contents are `*.state` files (the audit anchor state), by name. */
  stateDirs: Set<string>;
}

export function expectedFor(dataDir: string, env: Env): Expected {
  const files = new Set<string>();
  const stateDirs = new Set<string>();
  const keyFile = env.TURNTABLE_MASTER_KEY_FILE?.trim();
  if (keyFile && dirname(resolve(keyFile)) === resolve(dataDir)) {
    files.add(basename(keyFile));
    stateDirs.add(`${basename(keyFile)}.audit-state`);
  }
  // The audit anchor state of a key that comes from the environment lives here.
  stateDirs.add("audit-state");
  return { files, stateDirs };
}

export type FchownFn = (fd: number, uid: number, gid: number) => void;

/** True where a path relative to an open directory descriptor can be written as /proc/self/fd/N. */
const HAS_PROC_FD = process.platform === "linux";

/**
 * Opens `path` without following a final symlink and without blocking (a FIFO planted under an
 * expected name would otherwise hang the start), checks what it is through the descriptor (so
 * nothing can change between the check and the chown), chowns it, and runs `inside` while the
 * descriptor is still open. Refuses a symlink, a regular file with more than one link, anything
 * that is not a file or directory, and anything on another device than the data directory.
 * `shown` is the name used in messages (`path` may be a /proc/self/fd route).
 */
function chownChecked(
  path: string,
  shown: string,
  want: "file" | "dir",
  uid: number,
  gid: number,
  dev: number | undefined,
  fchown: FchownFn,
  inside?: (fd: number, st: Stats) => void,
): Stats {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (want === "dir" ? constants.O_DIRECTORY : 0),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new RootRefused(`${shown} is a symbolic link; refusing to start`);
    }
    throw new RootRefused(
      `cannot open ${shown} without following links (${code ?? "error"}); refusing to start`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (want === "file" && !st.isFile())
      throw new RootRefused(`${shown} is not a regular file; refusing to start`);
    if (want === "dir" && !st.isDirectory())
      throw new RootRefused(`${shown} is not a directory; refusing to start`);
    if (want === "file" && st.nlink > 1) {
      throw new RootRefused(`${shown} has ${st.nlink} hard links; refusing to start`);
    }
    if (dev !== undefined && st.dev !== dev) {
      throw new RootRefused(
        `${shown} is on another device than the data directory; refusing to start`,
      );
    }
    fchown(fd, uid, gid);
    inside?.(fd, st);
    return st;
  } finally {
    closeSync(fd);
  }
}

/**
 * A route to an entry of an open directory that cannot be redirected by swapping the directory
 * for a symlink: through the descriptor on Linux. Elsewhere the path is used, and the caller
 * proves the directory is still the same one (same device and inode, not a link) before and after.
 */
function childRoute(dirFd: number, dirPath: string, name: string): string {
  return HAS_PROC_FD ? `/proc/self/fd/${dirFd}/${name}` : join(dirPath, name);
}

function assertSameDir(dirPath: string, st: Stats): void {
  let now: Stats;
  try {
    now = lstatSync(dirPath);
  } catch {
    throw new RootRefused(`${dirPath} changed while it was being read; refusing to start`);
  }
  if (!now.isDirectory() || now.ino !== st.ino || now.dev !== st.dev) {
    throw new RootRefused(`${dirPath} changed while it was being read; refusing to start`);
  }
}

/**
 * Gives the data directory and the files Turntable expects in it to uid:gid. Not recursive in
 * general: the top level only, plus the contents of the audit state directory and of `backups`. An entry that is
 * not on the list stops the start, named, so nothing a past process planted is touched. Every
 * child is reached through the open descriptor of its parent, never by a path that a symlink
 * swapped in after the check could redirect.
 */
export function chownData(
  dataDir: string,
  uid: number,
  gid: number,
  env: Env = {},
  fchown: FchownFn = fchownSync,
): void {
  mkdirSync(dataDir, { recursive: true });
  chownChecked(dataDir, dataDir, "dir", uid, gid, undefined, fchown, (topFd, top) => {
    const expected = expectedFor(dataDir, env);
    const topRoute = HAS_PROC_FD ? `/proc/self/fd/${topFd}` : dataDir;
    for (const name of readdirSync(topRoute)) {
      if (SKIP.has(name)) continue;
      const shown = join(dataDir, name);
      const route = childRoute(topFd, dataDir, name);
      if (!HAS_PROC_FD) assertSameDir(dataDir, top);
      if (DB_FILE.test(name) || expected.files.has(name)) {
        chownChecked(route, shown, "file", uid, gid, top.dev, fchown);
      } else if (expected.stateDirs.has(name)) {
        chownChecked(route, shown, "dir", uid, gid, top.dev, fchown, (dirFd, dir) => {
          const inRoute = HAS_PROC_FD ? `/proc/self/fd/${dirFd}` : shown;
          for (const inner of readdirSync(inRoute)) {
            if (!/^[0-9A-Za-z]+\.state(\.tmp)?$/.test(inner)) {
              throw new RootRefused(
                `unexpected entry ${join(shown, inner)} in the audit state directory; refusing to start`,
              );
            }
            if (!HAS_PROC_FD) assertSameDir(shown, dir);
            chownChecked(
              childRoute(dirFd, shown, inner),
              join(shown, inner),
              "file",
              uid,
              gid,
              top.dev,
              fchown,
            );
            if (!HAS_PROC_FD) assertSameDir(shown, dir);
          }
        });
      } else if (name === BACKUPS_DIR) {
        // `db_backup` writes here: only its exact file names, each a plain single-link file.
        chownChecked(route, shown, "dir", uid, gid, top.dev, fchown, (dirFd, dir) => {
          const inRoute = HAS_PROC_FD ? `/proc/self/fd/${dirFd}` : shown;
          for (const inner of readdirSync(inRoute)) {
            if (!isBackupEntryName(inner)) {
              throw new RootRefused(
                `unexpected entry ${join(shown, inner)} in the backups directory; refusing to start`,
              );
            }
            if (!HAS_PROC_FD) assertSameDir(shown, dir);
            chownChecked(
              childRoute(dirFd, shown, inner),
              join(shown, inner),
              "file",
              uid,
              gid,
              top.dev,
              fchown,
            );
            if (!HAS_PROC_FD) assertSameDir(shown, dir);
          }
        });
      } else {
        throw new RootRefused(
          `unexpected entry ${shown} in the data directory; refusing to start as root with it there ` +
            "(remove it, or start without root)",
        );
      }
      if (!HAS_PROC_FD) assertSameDir(dataDir, top);
    }
  });
}

/** The real process. A platform that cannot do any step makes the drop impossible, so it throws. */
export function realOpsFor(p: NodeJS.Process = process): PrivilegeOps {
  const need = <T>(fn: T | undefined, name: string): T => {
    if (typeof fn !== "function") {
      throw new RootRefused(
        `process.${name} is not available here, so privileges cannot be dropped; refusing to run as root`,
      );
    }
    return fn;
  };
  return {
    uid: () => need(p.getuid, "getuid").call(p),
    gid: () => need(p.getgid, "getgid").call(p),
    groups: () => need(p.getgroups, "getgroups").call(p),
    chownData: (d, u, g, env) => chownData(d, u, g, env),
    setgroups: (g) => need(p.setgroups, "setgroups").call(p, g),
    setgid: (g) => need(p.setgid, "setgid").call(p, g),
    setuid: (u) => need(p.setuid, "setuid").call(p, u),
  };
}

export type PrivilegeOutcome = "not_root" | "dropped" | "root_allowed";

const throws = (f: () => void): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

/**
 * Call first in `serve`. Not root: nothing to do (a drop request is ignored). Root with a drop
 * spec: own the expected files, then groups, gid, uid, in that order; then check that the process
 * really is that user with exactly that one group, and that root cannot be regained by uid, gid
 * or group. Any failure refuses to run. Root with neither a spec nor TURNTABLE_ALLOW_ROOT=1:
 * refuse.
 */
export function enforceRootPolicy(
  dataDir: string,
  env: Env = process.env,
  ops: PrivilegeOps = realOpsFor(),
  opts: { chown?: boolean } = {},
): PrivilegeOutcome {
  if (ops.uid() !== 0) return "not_root";
  const spec = env.TURNTABLE_DROP_PRIVILEGES?.trim();
  if (spec) {
    const { uid, gid } = parseDropSpec(spec);
    // Only the server owns the data directory's files; other subcommands (docker exec) just drop.
    if (opts.chown !== false) ops.chownData(dataDir, uid, gid, env);
    // Supplementary groups first (root's own would survive setgid), then gid, then uid last:
    // after setuid there is no privilege left to change the others.
    ops.setgroups([gid]);
    ops.setgid(gid);
    ops.setuid(uid);
    const groups = ops.groups();
    if (ops.uid() !== uid || ops.gid() !== gid) {
      throw new RootRefused(
        `dropping privileges did not take effect (now uid ${ops.uid()}, gid ${ops.gid()})`,
      );
    }
    if (groups.length !== 1 || groups[0] !== gid) {
      throw new RootRefused(
        `supplementary groups were not cleared (now ${groups.join(",") || "none"})`,
      );
    }
    if (
      !throws(() => ops.setuid(0)) ||
      !throws(() => ops.setgid(0)) ||
      !throws(() => ops.setgroups([0]))
    ) {
      throw new RootRefused("root could be regained after dropping privileges; refusing to run");
    }
    if (ops.uid() !== uid || ops.gid() !== gid) {
      throw new RootRefused("the identity changed while checking that root cannot be regained");
    }
    return "dropped";
  }
  if (env.TURNTABLE_ALLOW_ROOT === "1") return "root_allowed";
  throw new RootRefused(
    "refusing to run as root. Set TURNTABLE_DROP_PRIVILEGES=65532:65532 to drop to an unprivileged user " +
      "(the data directory is chowned to it first), run as a non-root user, or set TURNTABLE_ALLOW_ROOT=1 " +
      "if running as root is intended.",
  );
}
