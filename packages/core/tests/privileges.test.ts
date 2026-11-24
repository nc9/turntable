import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BACKUP_NAME_RE,
  BACKUP_PARTIAL_RE,
  backupFileName,
  backupPartialName,
  isBackupEntryName,
} from "../src/db/backup-names";
import { DATA_DIR_COMMANDS, dataDirFromArgs, dropForCommand } from "../src/command-privileges";
import {
  chownData,
  enforceRootPolicy,
  parseDropSpec,
  realOpsFor,
  RootRefused,
  type PrivilegeOps,
} from "../src/privileges";

interface FakeOpts {
  /** The call does nothing, as if it were stubbed out. */
  noUid?: boolean;
  noGid?: boolean;
  noGroups?: boolean;
  /** Root can be taken back by this call. */
  regainUid?: boolean;
  regainGid?: boolean;
  regainGroups?: boolean;
  /** The kernel keeps these supplementary groups. */
  extraGroups?: number[];
}

/** A process that starts as root and records every privileged call, in order. */
function fake(opts: FakeOpts = {}) {
  const calls: string[] = [];
  let uid = 0;
  let gid = 0;
  let groups = [0, 4, 27];
  const ops: PrivilegeOps = {
    uid: () => uid,
    gid: () => gid,
    groups: () => groups,
    chownData: (d, u, g) => void calls.push(`chown ${d} ${u}:${g}`),
    setgroups: (g) => {
      calls.push(`setgroups ${g.join(",")}`);
      if (g.includes(0) && uid !== 0 && !opts.regainGroups) throw new Error("EPERM");
      if (!opts.noGroups) groups = [...g, ...(opts.extraGroups ?? [])];
    },
    setgid: (g) => {
      calls.push(`setgid ${g}`);
      if (g === 0 && uid !== 0 && !opts.regainGid) throw new Error("EPERM");
      if (!opts.noGid) gid = g;
    },
    setuid: (u) => {
      calls.push(`setuid ${u}`);
      if (u === 0 && uid !== 0 && !opts.regainUid) throw new Error("EPERM");
      if (!opts.noUid) uid = u;
    },
  };
  return { ops, calls, ids: () => [uid, gid, groups] as const };
}

const SPEC = { TURNTABLE_DROP_PRIVILEGES: "65532:65532" };

test("as root with a drop spec: own the data dir, then groups, gid, uid, in that order", () => {
  const f = fake();
  expect(enforceRootPolicy("/data", SPEC, f.ops)).toBe("dropped");
  expect(f.calls.slice(0, 4)).toEqual([
    "chown /data 65532:65532",
    "setgroups 65532",
    "setgid 65532",
    "setuid 65532",
  ]);
  expect(f.ids()).toEqual([65532, 65532, [65532]]);
});

test("each way the drop can fail is fatal: not taken, groups kept, root regainable", () => {
  const cases: [FakeOpts, RegExp][] = [
    [{ noUid: true }, /did not take effect/],
    [{ noGid: true }, /did not take effect/],
    [{ noGroups: true }, /groups were not cleared/],
    [{ extraGroups: [27] }, /groups were not cleared/],
    [{ regainUid: true }, /regained/],
    [{ regainGid: true }, /regained/],
    [{ regainGroups: true }, /regained/],
  ];
  for (const [opts, why] of cases) {
    expect(() => enforceRootPolicy("/data", SPEC, fake(opts).ops)).toThrow(why);
  }
});

test("a platform without setuid, setgid, setgroups or getgroups refuses to run as root", () => {
  const base = {
    getuid: () => 0,
    getgid: () => 0,
    getgroups: () => [0],
    setgroups: () => {},
    setgid: () => {},
    setuid: () => {},
  };
  for (const missing of ["getuid", "getgid", "getgroups", "setgroups", "setgid", "setuid"]) {
    const p = { ...base, [missing]: undefined } as unknown as NodeJS.Process;
    const ops = realOpsFor(p);
    // use whichever op needs the missing function; the first call that touches it throws
    expect(() => enforceRootPolicy("/data", SPEC, { ...ops, chownData: () => {} })).toThrow(
      RootRefused,
    );
  }
});

test("root with nothing set is refused; TURNTABLE_ALLOW_ROOT=1 allows it, and touches nothing", () => {
  expect(() => enforceRootPolicy("/data", {}, fake().ops)).toThrow(/refusing to run as root/);
  const f = fake();
  expect(enforceRootPolicy("/data", { TURNTABLE_ALLOW_ROOT: "1" }, f.ops)).toBe("root_allowed");
  expect(f.calls).toEqual([]);
  expect(() => enforceRootPolicy("/data", { TURNTABLE_ALLOW_ROOT: "true" }, fake().ops)).toThrow(
    RootRefused,
  );
});

test("a drop spec wins over ALLOW_ROOT, and a non-root process ignores both", () => {
  const f = fake();
  expect(
    enforceRootPolicy(
      "/data",
      { TURNTABLE_ALLOW_ROOT: "1", TURNTABLE_DROP_PRIVILEGES: "1000:1000" },
      f.ops,
    ),
  ).toBe("dropped");
  const calls: string[] = [];
  const nonRoot: PrivilegeOps = {
    ...fake().ops,
    uid: () => 65532,
    chownData: () => void calls.push("chown"),
  };
  expect(enforceRootPolicy("/data", SPEC, nonRoot)).toBe("not_root");
  expect(calls).toEqual([]);
});

test("the drop spec is validated: whole numbers, never root; a bad one stops before any chown", () => {
  expect(parseDropSpec("65532:65532")).toEqual({ uid: 65532, gid: 65532 });
  for (const bad of [
    "",
    "65532",
    "a:b",
    "0:0",
    "0:65532",
    "65532:0",
    "-1:5",
    "1:2:3",
    "65532:65532; id",
    "1.5:2",
  ]) {
    expect(() => parseDropSpec(bad)).toThrow();
  }
  const f = fake();
  expect(() => enforceRootPolicy("/data", { TURNTABLE_DROP_PRIVILEGES: "0:0" }, f.ops)).toThrow();
  expect(f.calls).toEqual([]);
});

// ---- the chown itself, against real files ----

let tmp: string;
let data: string;
let outside: string;
const chowned: string[] = [];
// fchown to ourselves is permitted without root; the spy records which inode was targeted.
const spy = (fd: number): void => void chowned.push(String(fd));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ls-priv-"));
  data = join(tmp, "data");
  outside = join(tmp, "outside");
  mkdirSync(data);
  mkdirSync(outside);
  writeFileSync(join(outside, "shadow"), "root:x");
  chowned.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (env: Record<string, string> = {}) => chownData(data, 1, 2, env, (fd) => spy(fd));

test("chowns the data dir and the database files, and nothing else", () => {
  // rename-keep-begin
  // The database under its current name and under the name it had before the rename.
  for (const f of ["turntable.db", "turntable.db-wal", "turntable.db-shm", "longshore.db"]) {
    // rename-keep-end
    writeFileSync(join(data, f), "x");
  }
  mkdirSync(join(data, "lost+found"));
  run();
  expect(chowned.length).toBe(5); // the dir and four files; lost+found left alone
});

test("a symlink planted in the data dir refuses the start, named, and nothing is chowned through it", () => {
  writeFileSync(join(data, "turntable.db"), "x");
  symlinkSync(join(outside, "shadow"), join(data, "turntable.db-wal"));
  expect(() => run()).toThrow(/turntable\.db-wal is a symbolic link/);
  // a symlinked data dir itself is refused too
  const link = join(tmp, "datalink");
  symlinkSync(data, link);
  expect(() => chownData(link, 1, 2, {}, spy)).toThrow(/symbolic link|cannot open/);
});

test("a hardlink to another file is refused: it IS that file", () => {
  linkSync(join(outside, "shadow"), join(data, "turntable.db"));
  expect(statSync(join(data, "turntable.db")).nlink).toBe(2);
  expect(() => run()).toThrow(/turntable\.db has 2 hard links/);
});

test("an unexpected file or directory stops the start, named", () => {
  writeFileSync(join(data, "turntable.db"), "x");
  writeFileSync(join(data, "evil"), "x");
  expect(() => run()).toThrow(/unexpected entry .*evil/);
  rmSync(join(data, "evil"));
  mkdirSync(join(data, "subdir"));
  expect(() => run()).toThrow(/unexpected entry .*subdir/);
});

test("the master key file and its audit state directory count only when they live in the data dir", () => {
  writeFileSync(join(data, "master.key"), "x");
  mkdirSync(join(data, "master.key.audit-state"));
  writeFileSync(join(data, "master.key.audit-state", "ABC123.state"), "x");
  expect(() => run()).toThrow(/unexpected entry/); // not told about the key
  chowned.length = 0;
  run({ TURNTABLE_MASTER_KEY_FILE: join(data, "master.key") });
  expect(chowned.length).toBe(4); // the dir, the key, the state dir and its one state file
});

test("the audit state directory holds only state files; a planted link or extra file there is refused", () => {
  const key = join(data, "master.key");
  mkdirSync(`${key}.audit-state`);
  symlinkSync(join(outside, "shadow"), join(`${key}.audit-state`, "ABC.state"));
  expect(() => run({ TURNTABLE_MASTER_KEY_FILE: key })).toThrow(/symbolic link/);
  rmSync(join(`${key}.audit-state`, "ABC.state"));
  writeFileSync(join(`${key}.audit-state`, "notes.txt"), "x");
  expect(() => run({ TURNTABLE_MASTER_KEY_FILE: key })).toThrow(/unexpected entry/);
});

// ---- the backups directory (#475) ----

const BACKUP = backupFileName(Date.now(), "1.2.3");

test("a backups dir with a finished backup and an in-progress temp file is chowned", () => {
  writeFileSync(join(data, "turntable.db"), "x");
  mkdirSync(join(data, "backups"));
  writeFileSync(join(data, "backups", BACKUP), "x");
  writeFileSync(
    join(
      data,
      "backups",
      backupPartialName(backupFileName(Date.now() + 1, "1.2.3", "pre-migrate")),
    ),
    "x",
  );
  run();
  expect(chowned.length).toBe(5); // data dir, the db, backups dir, two files
});

test("an unexpected name in backups refuses the start, named", () => {
  mkdirSync(join(data, "backups"));
  writeFileSync(join(data, "backups", "notes.txt"), "x");
  expect(() => run()).toThrow(/unexpected entry .*backups.notes\.txt/);
});

test("a symlink in backups is refused, even under a valid backup name", () => {
  mkdirSync(join(data, "backups"));
  symlinkSync(join(outside, "shadow"), join(data, "backups", BACKUP));
  expect(() => run()).toThrow(/symbolic link|cannot open/);
});

test("a subdirectory in backups is refused", () => {
  mkdirSync(join(data, "backups"));
  mkdirSync(join(data, "backups", "sub"));
  expect(() => run()).toThrow(/unexpected entry .*sub/);
  rmSync(join(data, "backups", "sub"), { recursive: true });
  mkdirSync(join(data, "backups", BACKUP));
  expect(() => run()).toThrow(/not a regular file|cannot open/);
});

test("a hardlinked file in backups is refused: it IS that file", () => {
  mkdirSync(join(data, "backups"));
  linkSync(join(outside, "shadow"), join(data, "backups", BACKUP));
  expect(() => run()).toThrow(/2 hard links/);
});

test("backups itself being a symlink is refused", () => {
  symlinkSync(outside, join(data, "backups"));
  expect(() => run()).toThrow(/symbolic link|cannot open/);
});

test("the backup name patterns match what backup-names generates, and little else", () => {
  for (const [version, label] of [
    ["0.1.0-alpha.1", undefined],
    ["1.2.3", "pre-migrate"],
    ["weird version/\u00e9", "la bel"],
    ["", ""],
  ] as const) {
    const name = backupFileName(Date.now(), version, label);
    expect(BACKUP_NAME_RE.test(name)).toBe(true);
    const partial = backupPartialName(name);
    expect(BACKUP_PARTIAL_RE.test(partial)).toBe(true);
    expect(isBackupEntryName(name) && isBackupEntryName(partial)).toBe(true);
    expect(BACKUP_NAME_RE.test(partial)).toBe(false);
  }
  for (const bad of [
    "",
    "turntable.db",
    ".turntable.db.partial",
    `${BACKUP}.bak`,
    `x${BACKUP}`,
    `../${BACKUP}`,
  ]) {
    expect(isBackupEntryName(bad)).toBe(false);
  }
});

test("a data dir that does not exist yet is created", () => {
  const fresh = join(tmp, "fresh");
  chownData(fresh, 1, 2, {}, spy);
  expect(statSync(fresh).isDirectory()).toBe(true);
});

// ---- the review of #129: FIFOs, link swaps, and every subcommand ----

const mkfifo = (path: string): void => {
  const r = Bun.spawnSync(["mkfifo", path]);
  if (r.exitCode !== 0) throw new Error("mkfifo failed");
};

test("a FIFO planted under an expected name does not hang the start: it is refused", () => {
  mkfifo(join(data, "turntable.db"));
  // O_NONBLOCK: the open returns at once, the descriptor says it is not a regular file.
  expect(() => run()).toThrow(/turntable\.db is not a regular file/);
  expect(chowned.length).toBe(1); // only the data dir itself
});

test("a FIFO in the audit state directory does not hang the start either", () => {
  const key = join(data, "master.key");
  mkdirSync(`${key}.audit-state`);
  mkfifo(join(`${key}.audit-state`, "ABC.state"));
  expect(() => run({ TURNTABLE_MASTER_KEY_FILE: key })).toThrow(/not a regular file/);
});

test("a symlink planted to a file outside the dir is never chowned", () => {
  symlinkSync(join(outside, "shadow"), join(data, "turntable.db"));
  const fds: number[] = [];
  expect(() => chownData(data, 1, 2, {}, (fd) => void fds.push(fd))).toThrow(/symbolic link/);
  expect(fds.length).toBe(1); // the data dir; the link's target was never opened for chown
});

test("a state directory swapped for a symlink to elsewhere is not followed", () => {
  const key = join(data, "master.key");
  symlinkSync(outside, `${key}.audit-state`);
  writeFileSync(join(outside, "ABC.state"), "x");
  expect(() => run({ TURNTABLE_MASTER_KEY_FILE: key })).toThrow(/symbolic link|cannot open/);
});

test("a drop without chown touches no file: other subcommands only drop", () => {
  const f = fake();
  expect(enforceRootPolicy(data, SPEC, f.ops, { chown: false })).toBe("dropped");
  expect(f.calls).toEqual([
    "setgroups 65532",
    "setgid 65532",
    "setuid 65532",
    "setuid 0",
    "setgid 0",
    "setgroups 0",
  ]);
});

test("every subcommand that opens the data dir drops (or refuses) first; the rest do not", () => {
  for (const c of DATA_DIR_COMMANDS) {
    const f = fake();
    expect(dropForCommand(c, [], SPEC, f.ops)).toBe("dropped");
    expect(f.ids()[0]).toBe(65532);
    expect(f.calls.some((x) => x.startsWith("chown"))).toBe(false);
    // as root with nothing set, it refuses instead of running as root
    expect(() => dropForCommand(c, [], {}, fake().ops)).toThrow(RootRefused);
  }
  for (const c of ["serve", "version", "help", "--version", undefined, "bogus"]) {
    const f = fake();
    expect(dropForCommand(c, [], {}, f.ops)).toBe("not_needed");
    expect(f.calls).toEqual([]);
  }
});

test("the data dir is read from the arguments as parseArgs reads it", () => {
  expect(dataDirFromArgs([])).toBe(resolve("./data"));
  expect(dataDirFromArgs(["create", "--data-dir", "/d"])).toBe("/d");
  expect(dataDirFromArgs(["--data-dir=/a", "--data-dir", "/b"])).toBe("/b");
  expect(dataDirFromArgs(["--", "--data-dir", "/x"])).toBe(resolve("./data"));
});

test("main() calls the drop before any subcommand runs", () => {
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const mainBody = src.slice(src.indexOf("async function main("));
  expect(mainBody.indexOf("dropForCommand(command, rest)")).toBeGreaterThan(0);
  expect(mainBody.indexOf("dropForCommand(command, rest)")).toBeLessThan(
    mainBody.indexOf("switch (command)"),
  );
});

test("the release lane branch drops (or refuses) before it opens anything, and does not chown", () => {
  const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const branch = src.slice(src.indexOf('if (roles.has("release"))'));
  const drop = branch.indexOf("enforceRootPolicy(");
  expect(drop).toBeGreaterThan(0);
  expect(drop).toBeLessThan(branch.indexOf("serveRelease(values)"));
  expect(branch.slice(drop, drop + 140)).toContain("chown: false");
});
