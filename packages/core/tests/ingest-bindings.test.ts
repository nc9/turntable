import { beforeEach, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  listAudit,
  listRuns,
  openDatabase,
  type Db,
} from "../src/db";
import { setProjectIngest } from "../src/db/repos";
import { setIngestPolicy, showIngest } from "../src/ops/policy-cli";
import { Poller, pollConfigSchema } from "../src/poll";
import { SHA, makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

let db: Db;
let clock: { t: number };
beforeEach(() => {
  db = openDatabase(":memory:");
  clock = { t: 1_800_000_000_000 };
});

async function tenant(slug: string, repo: [string, string] | undefined) {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  if (repo) {
    await bindRepo(
      db,
      { orgId: org.id, projectId: project.id },
      { forge: "github", owner: repo[0], repo: repo[1] },
    );
  }
  return { org, project, scope: { orgId: org.id, projectId: project.id } };
}

function poller(gh: ReturnType<typeof makeGithub>, over: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const p = new Poller({
    db,
    // a static repo that is never the one under test
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      ],
      ...over,
    }),
    fetch: gh.fetch,
    now: () => clock.t,
    log: (m) => logs.push(m),
    bindings: true,
  });
  return { p, logs };
}

const world = () => {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  return gh;
};

test("a bound repo is not ingested until its project has ingest settings", async () => {
  const t = await tenant("acme", ["acme", "web"]);
  const gh = world();
  const { p } = poller(gh);
  await p.pollAll();
  expect(await listRuns(db, t.scope)).toEqual([]);
  expect(gh.state.calls.some((c) => c.path.startsWith("/repos/acme/web"))).toBe(false);
});

test("with settings, the repo is ingested into ITS project on its stored default branch", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  const other = await tenant("other", ["other", "api"]); // bound, no settings: untouched
  const gh = world();
  await setIngestPolicy(db, "acme", "web", "on", { authors: ["octocat"], defaultBranch: "main" });
  const { p } = poller(gh);
  await p.pollAll();
  const runs = await listRuns(db, a.scope);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.event).toBe("push");
  expect(runs[0]?.sha).toBe(SHA("a"));
  expect(runs[0]?.ref).toBe("refs/heads/main"); // the stored default branch
  expect(await listRuns(db, other.scope)).toEqual([]);
});

test("turning ingest off stops it; the settings are audited with who is trusted", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  const gh = world();
  await setIngestPolicy(db, "acme", "web", "on", {
    prMode: "allowlist",
    authors: ["octocat"],
    defaultBranch: "main",
  });
  const { p } = poller(gh);
  await p.pollAll();
  expect(await listRuns(db, a.scope)).toHaveLength(1);
  await setIngestPolicy(db, "acme", "web", "off");
  clock.t += 10_000;
  gh.state.head = { sha: SHA("e"), message: "next", login: "octocat" };
  const before = gh.state.calls.length;
  await p.pollAll();
  expect(gh.state.calls.slice(before).some((c) => c.path.startsWith("/repos/acme/web"))).toBe(
    false,
  );
  expect(await listRuns(db, a.scope)).toHaveLength(1);
  const rows = (await listAudit(db, { orgId: a.org.id })).filter((r) => r.op === "policy_set");
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[1]!.input)).toMatchObject({
    key: "ingest",
    to: { prMode: "allowlist", authors: ["octocat"], defaultBranch: "main" },
  });
  expect((await showIngest(db, "acme"))[0]?.ingest).toBeNull();
});

test("a repo in the static poll config wins over its binding", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  const gh = world();
  gh.state.pulls.push({ number: 3, user: "octocat", headSha: SHA("d") });
  await setIngestPolicy(db, "acme", "web", "on", {
    prMode: "allowlist",
    authors: ["octocat"],
    defaultBranch: "main",
  });
  const { p } = poller(gh, {
    repos: [
      {
        repo: "acme/web",
        org: "acme",
        project: "web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "off",
      },
    ],
  });
  await p.pollAll();
  const runs = await listRuns(db, a.scope);
  expect(runs.map((r) => r.event)).toEqual(["push"]); // the static repo has pull requests off
  expect(gh.state.calls.some((c) => c.path === "/repos/acme/web")).toBe(false); // branch is configured
});

test("settings are validated; bad stored settings are skipped, not fatal", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  await expect(
    setIngestPolicy(db, "acme", "web", "on", { prMode: "everyone", defaultBranch: "main" }),
  ).rejects.toThrow(/invalid ingest settings/);
  await expect(setIngestPolicy(db, "acme", "web", "maybe")).rejects.toThrow(/on or off/);
  await expect(setIngestPolicy(db, "acme", undefined, "on")).rejects.toThrow(/--project/);
  await setProjectIngest(db, a.scope, "{not json");
  const gh = world();
  const { p, logs } = poller(gh);
  await p.pollAll();
  expect(logs.some((l) => l.includes("acme/web") && l.includes("skipped"))).toBe(true);
  expect(await listRuns(db, a.scope)).toEqual([]);
  await setProjectIngest(db, a.scope, JSON.stringify({ prMode: "allowlist", surprise: true }));
  clock.t += 10_000;
  await p.pollAll();
  expect(await listRuns(db, a.scope)).toEqual([]);
});

test("a webhook for a repo that just got settings makes the poller look, then poll it", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  const gh = world();
  const { p } = poller(gh);
  p.start();
  try {
    await Bun.sleep(100); // the first look at bindings finishes, finding nothing
    clock.t += 10_000; // past the refresh throttle
    await setIngestPolicy(db, "acme", "web", "on", { authors: ["octocat"], defaultBranch: "main" });
    expect(p.nudge("acme/web")).toBe(false); // not known yet: it refreshes first
    const deadline = Date.now() + 5000;
    while ((await listRuns(db, a.scope)).length === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(await listRuns(db, a.scope)).toHaveLength(1);
    // a repo nobody bound is still ignored, however the payload names it
    expect(p.nudge("evil/unbound")).toBe(false);
  } finally {
    p.stop();
  }
});

test("the default branch is fixed when ingest is turned on: resolved once, or required, never re-resolved by the poller", async () => {
  const a = await tenant("acme", ["acme", "web"]);
  // not given, no resolver: refused rather than guessed
  await expect(setIngestPolicy(db, "acme", "web", "on", { authors: ["octocat"] })).rejects.toThrow(
    /--default-branch/,
  );
  // not given, resolved once at set time and stored
  let asked = 0;
  const r = await setIngestPolicy(db, "acme", "web", "on", {
    authors: ["octocat"],
    resolveDefaultBranch: async (repo) => {
      asked++;
      expect(repo).toBe("acme/web");
      return "main";
    },
  });
  expect(asked).toBe(1);
  expect(r.to?.defaultBranch).toBe("main");
  // stored settings without a branch (an old or hand-edited row) are invalid, not guessed at
  await setProjectIngest(db, a.scope, JSON.stringify({ authors: ["octocat"] }));
  const gh0 = world();
  const { p: p0 } = poller(gh0);
  await p0.pollAll();
  expect(await listRuns(db, a.scope)).toEqual([]);
  await setIngestPolicy(db, "acme", "web", "on", { authors: ["octocat"], defaultBranch: "main" });

  // a repo admin flips GitHub's default branch to another branch: the stored one stays in use,
  // the drift is logged and audited once, and a push there is not classified as the default
  const gh = world();
  gh.state.defaultBranch = "evil";
  const { p, logs } = poller(gh);
  await p.pollAll();
  clock.t += 10_000;
  await p.pollAll();
  const runs = await listRuns(db, a.scope);
  expect(runs.map((x) => x.ref)).toEqual(["refs/heads/main"]);
  expect(gh.state.calls.some((c) => c.path.includes("/commits/evil"))).toBe(false);
  expect(logs.filter((l) => l.includes("default branch is now evil"))).toHaveLength(1);
  const drift = (await listAudit(db, { orgId: a.org.id })).filter(
    (x) => x.op === "ingest_default_branch_drift",
  );
  expect(drift).toHaveLength(1);
  expect(JSON.parse(drift[0]!.input)).toEqual({ repo: "acme/web", stored: "main", github: "evil" });
  // it moves again: said again, once
  gh.state.defaultBranch = "other";
  clock.t += 10_000;
  await p.pollAll();
  expect(
    (await listAudit(db, { orgId: a.org.id })).filter(
      (x) => x.op === "ingest_default_branch_drift",
    ),
  ).toHaveLength(2);
});
