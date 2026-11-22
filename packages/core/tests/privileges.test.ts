import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chownTree,
  enforceRootPolicy,
  parseDropSpec,
  RootRefused,
  type PrivilegeOps,
} from "../src/privileges";

/** A process that starts as `startUid` and records every privileged call, in order. */
function fake(startUid: number, opts: { dropDoesNothing?: boolean; canRegainRoot?: boolean } = {}) {
  const calls: string[] = [];
  let uid = startUid;
  let gid = startUid;
  const ops: PrivilegeOps = {
    uid: () => uid,
    gid: () => gid,
    chownTree: (d, u, g) => void calls.push(`chown ${d} ${u}:${g}`),
    setgroups: (g) => void calls.push(`setgroups ${g.join(",")}`),
    setgid: (g) => {
      calls.push(`setgid ${g}`);
      if (!opts.dropDoesNothing) gid = g;
    },
    setuid: (u) => {
      calls.push(`setuid ${u}`);
      if (u === 0 && uid !== 0 && !opts.canRegainRoot) throw new Error("EPERM");
      if (!opts.dropDoesNothing) uid = u;
    },
  };
  return { ops, calls, uid: () => uid, gid: () => gid };
}

test("as root with a drop spec: own the data dir, then groups, gid, uid, in that order", () => {
  const f = fake(0);
  const out = enforceRootPolicy("/data", { LONGSHORE_DROP_PRIVILEGES: "65532:65532" }, f.ops);
  expect(out).toBe("dropped");
  expect(f.calls.slice(0, 4)).toEqual([
    "chown /data 65532:65532",
    "setgroups 65532",
    "setgid 65532",
    "setuid 65532",
  ]);
  expect([f.uid(), f.gid()]).toEqual([65532, 65532]);
  // and the last thing it did was prove root cannot be regained
  expect(f.calls.at(-1)).toBe("setuid 0");
});

test("a drop that does not take effect, or that can be undone, is fatal", () => {
  expect(() =>
    enforceRootPolicy(
      "/data",
      { LONGSHORE_DROP_PRIVILEGES: "65532:65532" },
      fake(0, { dropDoesNothing: true }).ops,
    ),
  ).toThrow(RootRefused);
  expect(() =>
    enforceRootPolicy(
      "/data",
      { LONGSHORE_DROP_PRIVILEGES: "65532:65532" },
      fake(0, { canRegainRoot: true }).ops,
    ),
  ).toThrow(/regained/);
});

test("root with nothing set is refused; LONGSHORE_ALLOW_ROOT=1 allows it, and touches nothing", () => {
  expect(() => enforceRootPolicy("/data", {}, fake(0).ops)).toThrow(/refusing to run as root/);
  const f = fake(0);
  expect(enforceRootPolicy("/data", { LONGSHORE_ALLOW_ROOT: "1" }, f.ops)).toBe("root_allowed");
  expect(f.calls).toEqual([]);
  // only the exact value 1 counts
  expect(() => enforceRootPolicy("/data", { LONGSHORE_ALLOW_ROOT: "true" }, fake(0).ops)).toThrow(
    RootRefused,
  );
});

test("a drop spec wins over ALLOW_ROOT: it still drops", () => {
  const f = fake(0);
  expect(
    enforceRootPolicy(
      "/data",
      { LONGSHORE_ALLOW_ROOT: "1", LONGSHORE_DROP_PRIVILEGES: "1000:1000" },
      f.ops,
    ),
  ).toBe("dropped");
  expect(f.uid()).toBe(1000);
});

test("not root: nothing is done and a drop request is ignored", () => {
  const f = fake(65532);
  expect(enforceRootPolicy("/data", { LONGSHORE_DROP_PRIVILEGES: "65532:65532" }, f.ops)).toBe(
    "not_root",
  );
  expect(enforceRootPolicy("/data", {}, f.ops)).toBe("not_root");
  expect(f.calls).toEqual([]);
});

test("the drop spec is validated: whole numbers, never root", () => {
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
  // a bad spec stops a root server before anything is chowned
  const f = fake(0);
  expect(() => enforceRootPolicy("/data", { LONGSHORE_DROP_PRIVILEGES: "0:0" }, f.ops)).toThrow();
  expect(f.calls).toEqual([]);
});

test("chownTree visits every file and directory, creates a missing dir, and never follows a symlink", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ls-priv-"));
  try {
    const data = join(tmp, "data");
    mkdirSync(join(data, "sub"), { recursive: true });
    writeFileSync(join(data, "longshore.db"), "x");
    writeFileSync(join(data, "sub", "f"), "x");
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(data, "link"));
    const seen: string[] = [];
    chownTree(data, 1, 2, (p) => void seen.push(p));
    expect(seen.toSorted()).toEqual(
      [
        data,
        join(data, "longshore.db"),
        join(data, "sub"),
        join(data, "sub", "f"),
        join(data, "link"),
      ].toSorted(),
    );
    // the link itself is chowned (lchown), but nothing inside what it points to is visited
    expect(seen.some((p) => p.startsWith(outside))).toBe(false);
    // a data dir that does not exist yet is created
    const fresh = join(tmp, "fresh");
    chownTree(fresh, 1, 2, () => {});
    expect(Bun.file(fresh).size).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
