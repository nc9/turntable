// Running as root, and getting out of it. Some platforms (Railway) mount volumes owned by root,
// which a non-root image cannot write. The image therefore starts as root, and with
// LONGSHORE_DROP_PRIVILEGES=<uid>:<gid> the server takes ownership of its data directory and
// drops to that user BEFORE it opens anything else: no database, no key file, no socket is ever
// touched as root. A server that is still root after startup is refused unless the operator
// said LONGSHORE_ALLOW_ROOT=1.
import { lchownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class RootRefused extends Error {}

/** What the policy needs from the process, so tests can watch the order of the calls. */
export interface PrivilegeOps {
  uid(): number;
  gid(): number;
  chownTree(dir: string, uid: number, gid: number): void;
  setgroups(groups: number[]): void;
  setgid(gid: number): void;
  setuid(uid: number): void;
}

/** `uid:gid`, both whole numbers, neither root. */
export function parseDropSpec(spec: string): { uid: number; gid: number } {
  const m = /^(\d{1,10}):(\d{1,10})$/.exec(spec.trim());
  if (!m) throw new Error("LONGSHORE_DROP_PRIVILEGES must be <uid>:<gid>, for example 65532:65532");
  const uid = Number(m[1]);
  const gid = Number(m[2]);
  if (uid === 0 || gid === 0)
    throw new Error("LONGSHORE_DROP_PRIVILEGES cannot name root (uid or gid 0)");
  return { uid, gid };
}

/**
 * Gives `dir` and everything under it to uid:gid. Uses lchown and never follows a symlink, so a
 * link planted in the volume cannot make root hand a file elsewhere to the service user.
 */
export function chownTree(
  dir: string,
  uid: number,
  gid: number,
  chown: (path: string, uid: number, gid: number) => void = lchownSync,
): void {
  mkdirSync(dir, { recursive: true });
  const walk = (p: string): void => {
    chown(p, uid, gid);
    if (!lstatSync(p).isDirectory()) return;
    for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(dir);
}

export const realOps: PrivilegeOps = {
  uid: () => process.getuid?.() ?? -1,
  gid: () => process.getgid?.() ?? -1,
  chownTree: (d, u, g) => chownTree(d, u, g),
  setgroups: (g) => process.setgroups?.(g),
  setgid: (g) => process.setgid?.(g),
  setuid: (u) => process.setuid?.(u),
};

export type PrivilegeOutcome = "not_root" | "dropped" | "root_allowed";

/**
 * Call first in `serve`. Not root: nothing to do (a drop request is ignored). Root with a drop
 * spec: own the data dir, then groups, gid, uid, in that order, and prove root cannot be
 * regained. Root with neither a drop spec nor LONGSHORE_ALLOW_ROOT=1: refuse.
 */
export function enforceRootPolicy(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  ops: PrivilegeOps = realOps,
): PrivilegeOutcome {
  if (ops.uid() !== 0) return "not_root";
  const spec = env.LONGSHORE_DROP_PRIVILEGES?.trim();
  if (spec) {
    const { uid, gid } = parseDropSpec(spec);
    ops.chownTree(dataDir, uid, gid);
    // Supplementary groups first (root's own would survive setgid), then gid, then uid last:
    // after setuid there is no privilege left to change the others.
    ops.setgroups([gid]);
    ops.setgid(gid);
    ops.setuid(uid);
    if (ops.uid() !== uid || ops.gid() !== gid) {
      throw new RootRefused(`dropping privileges did not take effect (still uid ${ops.uid()})`);
    }
    let regained = false;
    try {
      ops.setuid(0);
      regained = true;
    } catch {
      // expected: root cannot be regained
    }
    if (regained)
      throw new RootRefused("root could be regained after dropping privileges; refusing to run");
    return "dropped";
  }
  if (env.LONGSHORE_ALLOW_ROOT === "1") return "root_allowed";
  throw new RootRefused(
    "refusing to run as root. Set LONGSHORE_DROP_PRIVILEGES=65532:65532 to drop to an unprivileged user " +
      "(the data directory is chowned to it first), run as a non-root user, or set LONGSHORE_ALLOW_ROOT=1 " +
      "if running as root is intended.",
  );
}
