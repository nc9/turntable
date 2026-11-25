// A job in a project whose effective checks_mode is not `live` never holds a write-capable
// GITHUB_TOKEN (#641): GitHub Actions is still the system of record, so a side-by-side run must not
// repeat its writes. Runner level with a fake App authority, on SQLite and on Postgres (pglite).
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { eq } from "drizzle-orm";
import {
  type Db,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
  type Scope,
  setProjectChecksMode,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import * as s from "../src/db/schema";
import { JobTokens, SHADOW_LOWERED_NOTICE, type TokenAuthority } from "../src/github/job-token";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { createActRunner, Scheduler } from "../src/scheduler";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime, type SettingsRuntime } from "../src/settings/resolve";
import { loadTomlSettings } from "../src/settings/toml";
import { makeGithub } from "./github-stub";

setDefaultTimeout(30_000);

const tmp = mkdtempSync(join(tmpdir(), "tt-job-token-shadow-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
const opened: Db[] = [];
afterAll(() => {
  world.dispose();
  for (const d of opened) d.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Built at run time: a literal in this shape trips secret scanners.
const TOKEN = ["ghs", "shadow", "token", "value", "41cd02"].join("_");

const FAKE_ACT = String.raw`#!/bin/sh
J=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen"
printf '%s' "$GITHUB_TOKEN" > "$R/seen/env-$J.txt"
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
`;

const CFG = (): PollRepoConfig =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat"],
      },
    ],
  }).repos[0] as PollRepoConfig;

const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  [
    "postgres",
    () => {
      const t = testDb();
      return openPostgres(
        t && t !== "pglite"
          ? { url: t, schema: `lstest_job_token_shadow_${process.pid}` }
          : { pglite: true },
        { fresh: true },
      );
    },
  ],
];

const WRITE_GRANT = { metadata: "read", contents: "write", issues: "write" };
const WF = (perm: string): string =>
  `name: t\non: push\n${perm}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
const ISSUES_WRITE = "permissions:\n  issues: write\n";
const RELEASE_WRITE = "permissions:\n  contents: write\n";

const lock = (mode: "off" | "shadow" | "live"): SettingsRuntime =>
  createSettingsRuntime(
    settingsRegistry,
    {},
    loadTomlSettings("t.toml", settingsRegistry, () =>
      ["[orgs.local.projects.local]", `checks_mode = "${mode}"`].join("\n"),
    ),
  );

for (const [dialect, open] of dialects) {
  describe(`shadow tokens (${dialect})`, () => {
    let db: Db;
    let scope: Required<Scope>;
    let root: string;
    beforeEach(async () => {
      db = open();
      opened.push(db);
      scope = await ensureLocalTenant(db);
      root = join(mkdtempSync(join(tmp, "root-")), "tt");
    });

    function authority(isPublic: boolean) {
      const minted: unknown[] = [];
      const revoked: string[] = [];
      const auth: TokenAuthority = {
        mintFresh: async (installationId, sc) => {
          minted.push({ installationId, ...sc });
          return { token: TOKEN, expiresAt: Date.now() + 3_600_000 };
        },
        installationPermissions: async () => WRITE_GRANT,
        revoke: async (t) => {
          revoked.push(t);
          return true;
        },
      };
      return {
        minted,
        revoked,
        tokens: new JobTokens(auth, { isPublic: async () => isPublic }),
      };
    }

    /** Runs the one job of a push workflow and returns its log and the token it saw. */
    async function runIt(o: {
      yaml: string;
      klass: "protected" | "release";
      mode: "off" | "shadow" | "live";
      pub: boolean;
      locked?: "off" | "shadow" | "live";
      ref?: string;
    }) {
      const gh = makeGithub();
      gh.state.files.set("*", o.yaml);
      await pollRepo(
        {
          db,
          github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
          provider: "fake",
        },
        CFG(),
      );
      const [run] = await listRuns(db, scope);
      await db.run((h) => h.orm.update(s.projectRepos).set({ installationId: "100" }));
      const hash = createHash("sha256").update(o.yaml).digest("hex");
      await db.run((h) =>
        h.orm
          .update(s.runs)
          .set({
            trust: JSON.stringify({ class: o.klass, workflowHash: hash }),
            ...(o.ref ? { ref: o.ref } : {}),
          })
          .where(eq(s.runs.id, run!.id)),
      );
      await setProjectChecksMode(db, scope, o.mode);
      const [job] = await listJobs(db, scope, run!.id);

      const d = mkdtempSync(join(tmp, "a-"));
      writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
      const bytes = await tarDirectory(d, ["act"]);
      const r = mkdtempSync(join(tmp, "r-"));
      writeFileSync(join(r, "README.md"), "hi\n");
      const tarball = await tarDirectory(r, ["README.md"]);
      const a = authority(o.pub);
      const provider = world.provider();
      const start = provider.exec.start.bind(provider.exec);
      provider.exec.start = (id, x) =>
        x.argv.includes("canary")
          ? start(id, { ...x, argv: ["sh", "-c", "exit 0"] })
          : start(id, x);
      const sched = new Scheduler({
        db,
        providers: () => provider,
        runner: createActRunner({
          db,
          source: {
            checkout: async () => ({
              tarball,
              readFile: (p: string) => (p === ".github/workflows/ci.yml" ? o.yaml : undefined),
            }),
          },
          resolver: staticResolver({}),
          act: { bytes, sha256: sha256Hex(bytes) },
          planRoot: root,
          pollMs: 30,
          jobTokens: a.tokens,
          ...(o.locked ? { settings: lock(o.locked) } : {}),
        }),
        globalCap: 1,
        perOrgCap: 1,
        leaseMs: 60_000,
        pollMs: 20,
        ...(o.locked ? { settings: lock(o.locked) } : {}),
      });
      await sched.tick();
      await sched.idle();
      const [att] = await listAttempts(db, scope, job!.id);
      const log = Buffer.concat((await readLog(db, scope, att!.id)).map((c) => c.bytes)).toString();
      return { ...a, log, seen: readFileSync(join(root, "seen", "env-build.txt"), "utf8") };
    }

    test("a protected push job with issues: write in a shadow project on a private repo gets a read-only token and the notice", async () => {
      const r = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "shadow",
        pub: false,
      });
      // Nothing beyond read was even requested of GitHub.
      expect(r.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      expect(r.seen).toBe(TOKEN);
      expect(r.log).toContain(SHADOW_LOWERED_NOTICE);
      expect(r.log).not.toContain("issues:write");
      expect(r.revoked).toEqual([TOKEN]);
    });

    test("the same job on a public repo gets no token, and the notice", async () => {
      const r = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "shadow",
        pub: true,
      });
      expect(r.minted).toEqual([]);
      expect(r.seen).toBe("");
      expect(r.log).toContain(SHADOW_LOWERED_NOTICE);
    });

    test("a job that declared nothing beyond contents read gets no notice in shadow", async () => {
      const r = await runIt({ yaml: WF(""), klass: "protected", mode: "shadow", pub: true });
      expect(r.minted).toEqual([]);
      expect(r.log).not.toContain(SHADOW_LOWERED_NOTICE);
    });

    test("an off project is capped like a shadow one", async () => {
      const r = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "off",
        pub: false,
      });
      expect(r.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
    });

    test("the same job in a live project keeps issues: write", async () => {
      const r = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "live",
        pub: false,
      });
      expect(r.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { metadata: "read", issues: "write" },
        },
      ]);
      expect(r.log).not.toContain(SHADOW_LOWERED_NOTICE);
    });

    test("a release-class job in shadow is lowered", async () => {
      const r = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "release",
        mode: "shadow",
        pub: false,
      });
      expect(r.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      expect(r.log).toContain(SHADOW_LOWERED_NOTICE);
    });

    test("a tag run of a release job with contents: write in shadow gets read-only, or none on a public repo", async () => {
      const priv = await runIt({
        yaml: WF(RELEASE_WRITE),
        klass: "release",
        mode: "shadow",
        pub: false,
        ref: "refs/tags/v1.0.0",
      });
      expect(priv.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      expect(priv.log).toContain(SHADOW_LOWERED_NOTICE);
    });

    test("a tag run of a release job with contents: write in shadow on a public repo gets none", async () => {
      const pub = await runIt({
        yaml: WF(RELEASE_WRITE),
        klass: "release",
        mode: "shadow",
        pub: true,
        ref: "refs/tags/v1.0.0",
      });
      expect(pub.minted).toEqual([]);
      expect(pub.seen).toBe("");
      expect(pub.log).toContain(SHADOW_LOWERED_NOTICE);
    });

    test("a turntable.toml lock on checks_mode decides, not the stored column", async () => {
      // Stored live, locked shadow: capped.
      const capped = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "live",
        locked: "shadow",
        pub: false,
      });
      expect(capped.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      expect(capped.log).toContain(SHADOW_LOWERED_NOTICE);
    });

    test("stored shadow but locked live: the write scope is kept", async () => {
      const live = await runIt({
        yaml: WF(ISSUES_WRITE),
        klass: "protected",
        mode: "shadow",
        locked: "live",
        pub: false,
      });
      expect(live.minted).toEqual([
        {
          installationId: "100",
          repositories: ["web"],
          permissions: { metadata: "read", issues: "write" },
        },
      ]);
    });
  });
}
