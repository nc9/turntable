import { beforeEach, expect, test } from "bun:test";
import { bindRepo, createOrg, createProject, listRuns, openDatabase, type Db } from "../src/db";
import { ingestStatusOp } from "../src/ops/definitions/ingest-status";
import { Poller, pollConfigSchema, resetIngestStatus } from "../src/poll";
import { setIngestPolicy } from "../src/ops/policy-cli";
import { makeGithub } from "./github-stub";

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
  resetIngestStatus();
});

// Built at runtime: never a token-like literal in the repo.
const installToken = (n: number): string => ["inst", "tok", String(n)].join("_");
const pollToken = ["fallback", "secret", "value"].join("_");

type Mint = { id: string; scope: { repositories?: readonly string[]; permissions?: object } };

async function tenant(slug: string, repo: string, installationId?: string) {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  const scope = { orgId: org.id, projectId: project.id };
  const [owner, name] = repo.split("/") as [string, string];
  await bindRepo(db, scope, {
    forge: "github",
    owner,
    repo: name,
    ...(installationId ? { installationId } : {}),
  });
  await setIngestPolicy(db, slug, "web", "on", { authors: ["octocat"], defaultBranch: "main" });
  return { org, scope };
}

function setup(
  minter: { mint: (id: string, s: Mint["scope"]) => Promise<{ token: string }> },
  etags = false,
) {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  let conditional = 0;
  const auths: string[] = [];
  const logs: string[] = [];
  const p = new Poller({
    db,
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      ],
    }),
    auth: minter,
    fetch: async (url, init) => {
      if (new URL(url).pathname.startsWith("/repos/acme/")) {
        auths.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      if (!etags) return gh.fetch(url, init);
      // Every answer carries an ETag, and a matching conditional request gets a 304.
      if (new Headers(init?.headers).has("if-none-match")) {
        conditional++;
        return new Response(null, { status: 304 });
      }
      const res = await gh.fetch(url, init);
      const h = new Headers(res.headers);
      h.set("etag", `"${new URL(url).pathname}"`);
      return new Response(res.body, { status: res.status, headers: h });
    },
    now: () => clock.t,
    log: (m) => logs.push(m),
    bindings: true,
  });
  return { gh, p, auths, logs, conditional: () => conditional };
}

test("an installed repo is polled with a token minted read-only for that one repo", async () => {
  const t = await tenant("acme", "acme/web", "42");
  const mints: Mint[] = [];
  const { p, auths } = setup({
    async mint(id, scope) {
      mints.push({ id, scope });
      return { token: installToken(1) };
    },
  });
  await p.pollAll();
  expect(await listRuns(db, t.scope)).toHaveLength(1);
  expect(mints.length).toBeGreaterThan(0);
  for (const m of mints) {
    expect(m.id).toBe("42");
    expect(m.scope.repositories).toEqual(["web"]);
    expect(m.scope.permissions).toEqual({
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    });
  }
  expect(auths.length).toBeGreaterThan(0);
  for (const a of auths) expect(a).toBe(`Bearer ${installToken(1)}`);
});

test("a repo with no installation stays on the fallback and never mints", async () => {
  await tenant("acme", "acme/web");
  let mints = 0;
  const { p, auths } = setup({
    async mint() {
      mints++;
      return { token: installToken(1) };
    },
  });
  await p.pollAll();
  expect(mints).toBe(0);
  expect(auths.length).toBeGreaterThan(0);
  for (const a of auths) expect(a).toBe("");
});

test("a mint failure falls back with one warning per interval and never stalls", async () => {
  const t = await tenant("acme", "acme/web", "42");
  const { p, auths, logs } = setup({
    async mint() {
      throw new Error("minting an installation token failed: HTTP 500");
    },
  });
  await p.pollAll();
  await p.pollAll();
  expect(await listRuns(db, t.scope)).toHaveLength(1); // the poll still ran, anonymously
  for (const a of auths) expect(a).toBe("");
  const warns = logs.filter((l) => l.includes("could not mint"));
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain("acme/web");
  clock.t += 3600 * 1000;
  await p.pollAll();
  expect(logs.filter((l) => l.includes("could not mint"))).toHaveLength(2);
});

test("a re-minted token replaces the old one and the ETag cache survives it", async () => {
  await tenant("acme", "acme/web", "42");
  let n = 0;
  const { p, auths, conditional } = setup(
    {
      async mint() {
        return { token: installToken(++n) };
      },
    },
    true,
  );
  await p.pollAll();
  const first = auths.length;
  await p.pollAll();
  expect(auths.slice(first).every((a) => a === `Bearer ${installToken(2)}`)).toBe(true);
  expect(conditional()).toBeGreaterThan(0);
});

test("the installation budget is tracked apart and ingest_status reports the mode, with no token", async () => {
  const t = await tenant("acme", "acme/web", "42");
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  const logs: string[] = [];
  const p = new Poller({
    db,
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
      ],
    }),
    auth: { mint: async () => ({ token: installToken(1) }) },
    fetch: async (url, init) => {
      const res = await gh.fetch(url, init);
      const h = new Headers(res.headers);
      const installed = new Headers(init?.headers).has("authorization");
      h.set("x-ratelimit-limit", installed ? "5000" : "60");
      h.set("x-ratelimit-remaining", installed ? "4990" : "50");
      h.set("x-ratelimit-reset", "1800003600");
      return new Response(res.body, { status: res.status, headers: h });
    },
    now: () => clock.t,
    log: (m) => logs.push(m),
    bindings: true,
  });
  await p.pollAll();
  const out = (await ingestStatusOp.handler({ db, scope: t.scope } as never, {})) as {
    repos: { repo: string; auth_mode: string; rate_limit: { limit: number } | null }[];
    rate_limit_by_mode: { installation: { limit: number; remaining: number } | null };
  };
  const web = out.repos.find((r) => r.repo === "acme/web");
  expect(web?.auth_mode).toBe("installation");
  expect(web?.rate_limit?.limit).toBe(5000);
  expect(out.rate_limit_by_mode.installation).toMatchObject({ limit: 5000, remaining: 4990 });
  const json = JSON.stringify(out) + logs.join("\n");
  expect(json).not.toContain(installToken(1));
  expect(json).not.toContain(pollToken);
});
