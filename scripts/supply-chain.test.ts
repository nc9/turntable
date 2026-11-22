import { describe, expect, test } from "bun:test";
import { addedPackages, checkAges, parseAllowlist, type PublishedAt } from "./dep-age";
import { parseLock, resolveDep } from "./lockfile";
import {
  groupCommits,
  parseCommit,
  readMigrations,
  renderNotes,
  type Commit,
} from "./release-notes";
import { buildSbom, purl } from "./sbom";

const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "": { "name": "root", "devDependencies": { "tool": "1.0.0" } },
    "packages/core": { "name": "@x/core", "dependencies": { "@x/util": "workspace:*", "left": "1.0.0", "@sc/pkg": "2.0.0" }, "devDependencies": { "devonly": "1.0.0" } },
    "packages/ui": { "name": "@x/ui", "dependencies": { "react": "19.0.0" } },
    "packages/util": { "name": "@x/util", "dependencies": { "shared": "^1.0.0" } }
  },
  "packages": {
    "@x/core": ["@x/core@workspace:packages/core"],
    "@x/util": ["@x/util@workspace:packages/util"],
    "@x/ui": ["@x/ui@workspace:packages/ui"],
    "left": ["left@1.0.0", "", { "dependencies": { "shared": "^1.0.0", "nested": "^1.0.0" } }, "sha512-AAAA"],
    "left/nested": ["nested@1.5.0", "", {}, "sha512-BBBB"],
    "nested": ["nested@2.0.0", "", {}, "sha512-CCCC"],
    "shared": ["shared@1.2.3", "", {}, "sha512-DDDD"],
    "@sc/pkg": ["@sc/pkg@2.0.0", "", {}, "sha512-EEEE"],
    "react": ["react@19.0.0", "", {}, "sha512-FFFF"],
    "devonly": ["devonly@1.0.0", "", {}, "sha512-GGGG"],
    "tool": ["tool@1.0.0", "", {}, "sha512-HHHH"]
  }
}`;

describe("sbom", () => {
  test("is the runtime closure of the shipped workspaces, with hashes and the nested copy", () => {
    const sbom = buildSbom({
      lockText: LOCK,
      version: "0.1.0-alpha.1",
      timestamp: "2026-01-01T00:00:00Z",
      serialNumber: "urn:uuid:x",
    });
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.5");
    const names = sbom.components.map((c) => `${c.name}@${c.version}`);
    expect(names).toEqual([
      "@sc/pkg@2.0.0",
      "left@1.0.0",
      "nested@1.5.0",
      "react@19.0.0",
      "shared@1.2.3",
    ]);
    // Dev-only packages and workspace packages are not components.
    expect(names.join()).not.toContain("devonly");
    expect(names.join()).not.toContain("tool");
    expect(names.join()).not.toContain("@x/");
    const scoped = sbom.components.find((c) => c.name === "@sc/pkg")!;
    expect(scoped.purl).toBe("pkg:npm/%40sc/pkg@2.0.0");
    expect(scoped.hashes[0]).toMatchObject({ alg: "SHA-512" });
    // left depends on its own nested copy, not the top-level nested@2.
    const left = sbom.dependencies.find((d) => d.ref === purl("left", "1.0.0"))!;
    expect(left.dependsOn).toContain(purl("nested", "1.5.0"));
    expect(left.dependsOn).not.toContain(purl("nested", "2.0.0"));
    // The workspace util's dependency (shared) is reachable from the root.
    const root = sbom.dependencies[0]!;
    expect(root.ref).toBe("pkg:generic/longshore@0.1.0-alpha.1");
    expect(root.dependsOn).toContain(purl("left", "1.0.0"));
  });

  test("builds from the real lockfile", async () => {
    const sbom = buildSbom({
      lockText: await Bun.file(`${import.meta.dir}/../bun.lock`).text(),
      version: "0.0.0",
    });
    const names = sbom.components.map((c) => c.name);
    for (const n of ["zod", "yaml", "react", "drizzle-orm", "@modelcontextprotocol/sdk"])
      expect(names).toContain(n);
    for (const n of ["typescript", "oxlint", "drizzle-kit"]) expect(names).not.toContain(n);
    expect(sbom.components.every((c) => c.hashes.length > 0)).toBe(true);
  });

  test("resolveDep prefers the nested copy", () => {
    const lock = parseLock(LOCK);
    expect(resolveDep(lock, "left", "nested")?.version).toBe("1.5.0");
    expect(resolveDep(lock, "", "nested")?.version).toBe("2.0.0");
    expect(resolveDep(lock, "left", "shared")?.version).toBe("1.2.3");
  });
});

describe("dependency age", () => {
  const NOW = new Date("2026-11-23T00:00:00Z");
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  const published =
    (m: Record<string, number | null>): PublishedAt =>
    async (n, v) => {
      const d = m[`${n}@${v}`];
      return d === undefined || d === null ? null : daysAgo(d);
    };

  test("only versions new against the base lockfile are checked", () => {
    const base = LOCK;
    const head = LOCK.replace('"shared@1.2.3"', '"shared@1.2.4"');
    expect(addedPackages(base, head)).toEqual(["shared@1.2.4"]);
    expect(addedPackages(base, base)).toEqual([]);
    expect(addedPackages(null, base)).toContain("left@1.0.0");
  });

  test("fails under 14 days, passes at 14, honours the allowlist and its expiry", async () => {
    const added = ["young@1.0.0", "edge@1.0.0", "old@1.0.0", "excused@1.0.0", "lapsed@1.0.0"];
    const pub = published({
      "young@1.0.0": 3,
      "edge@1.0.0": 14,
      "old@1.0.0": 200,
      "excused@1.0.0": 2,
      "lapsed@1.0.0": 2,
    });
    const r = await checkAges({
      added,
      publishedAt: pub,
      now: NOW,
      allowlist: [
        { name: "excused", version: "1.0.0", reason: "security fix" },
        { name: "lapsed", version: "1.0.0", reason: "was fine", expires: "2026-11-01" },
      ],
    });
    expect(r.failures.map((f) => f.id)).toEqual(["young@1.0.0", "lapsed@1.0.0"]);
    expect(r.failures[0]!.reason).toContain("3d ago");
    expect(r.failures[1]!.reason).toContain("expired");
    expect(r.allowed.map((a) => a.id)).toEqual(["excused@1.0.0"]);
  });

  test("a package with no registry publish time needs an allowlist entry", async () => {
    const pub = published({});
    const none = await checkAges({
      added: ["gitdep@1.0.0"],
      allowlist: [],
      publishedAt: pub,
      now: NOW,
    });
    expect(none.failures).toHaveLength(1);
    const ok = await checkAges({
      added: ["gitdep@1.0.0"],
      allowlist: [{ name: "gitdep", version: "1.0.0", reason: "vendored fork" }],
      publishedAt: pub,
      now: NOW,
    });
    expect(ok.failures).toHaveLength(0);
  });

  test("allowlist entries need a reason", () => {
    expect(() => parseAllowlist('[{"name":"a","version":"1.0.0","reason":" "}]')).toThrow(/reason/);
    expect(parseAllowlist("[]")).toEqual([]);
  });
});

describe("release notes", () => {
  const c = (sha: string, subject: string, body = ""): Commit => ({ sha, subject, body });

  test("parses type, scope, breaking marker and footer", () => {
    expect(parseCommit(c("abc1234567", "feat(api)!: drop v0 routes"))).toMatchObject({
      type: "feat",
      scope: "api",
      breaking: true,
    });
    expect(
      parseCommit(
        c(
          "d",
          "fix(db): rename column",
          "details\n\nBREAKING CHANGE: the org column is now org_id\nrun the migration",
        ),
      ),
    ).toMatchObject({
      breaking: true,
      breakingNote: "the org column is now org_id run the migration",
    });
    expect(parseCommit(c("e", "update stuff"))).toBeNull();
    expect(parseCommit(c("f", "feat: no scope"))).toBeNull();
  });

  test("groups by type in a fixed order and lists breaking changes and migrations", () => {
    const commits = [
      c("1111111aaaa", "fix(ui): tooltip focus"),
      c("2222222bbbb", "feat(api)!: drop v0 routes", "BREAKING CHANGE: v0 routes are gone"),
      c("3333333cccc", "chore(deps): bump yaml"),
      c("4444444dddd", "feat(scheduler): group queueing"),
      c("5555555eeee", "WIP something"),
    ];
    const g = groupCommits(commits.map(parseCommit).filter((p) => p !== null));
    expect([...g.keys()]).toEqual(["feat", "fix", "chore"]);
    const out = renderNotes({
      template: "{{version}}|{{breaking}}|{{migrations}}|{{changes}}|{{skipped}}|{{compare}}",
      version: "0.1.0-alpha.2",
      from: "v0.1.0-alpha.1",
      commits,
      migrations: ["0010_new.sql", "0011_more.sql"],
      repo: "nc9/longshore",
    });
    expect(out).toContain("0.1.0-alpha.2|");
    expect(out).toContain("- **api:** drop v0 routes (2222222)\n  v0 routes are gone");
    expect(out).toContain("`0010_new.sql`");
    expect(out).toContain("migrations do not roll back");
    expect(out.indexOf("### Features")).toBeLessThan(out.indexOf("### Fixes"));
    expect(out).toContain("1 commit(s) without a conventional header");
    expect(out).toContain("compare/v0.1.0-alpha.1...v0.1.0-alpha.2");
    const none = renderNotes({
      template: "{{breaking}}|{{migrations}}",
      version: "1",
      from: null,
      commits: [],
      migrations: [],
    });
    expect(none).toBe("None.|No database migrations in this release.");
  });

  test("lists migration files added between two real refs", async () => {
    const files = await readMigrations(null, "HEAD");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /^\d{4}_.+\.sql$/.test(f))).toBe(true);
    expect(files).toEqual(files.toSorted());
  });
});
