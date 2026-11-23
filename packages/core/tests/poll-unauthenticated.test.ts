import { expect, test } from "bun:test";
import { ensureLocalTenant, openDatabase } from "../src/db";
import {
  GithubClient,
  minAnonymousIntervalSeconds,
  Poller,
  pollConfigSchema,
  pollRepo,
  requestsPerPoll,
} from "../src/poll";
import { makeGithub, SHA } from "./github-stub";

const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: echo hi }]
`;

const cfg = (extra: Record<string, unknown> = {}) =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        ...extra,
      },
    ],
  });

test("a config with no token is accepted only with allowUnauthenticated; a token is still refused inline", () => {
  const repos = [{ repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" }];
  expect(() => pollConfigSchema.parse({ repos })).toThrow(/tokenFile or tokenEnv/);
  expect(() => pollConfigSchema.parse({ allowUnauthenticated: true, repos })).not.toThrow();
  expect(() => pollConfigSchema.parse({ token: "x", allowUnauthenticated: true, repos })).toThrow();
});

test("an unauthenticated client sends no Authorization header and only conditional GETs", async () => {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  const seen: Headers[] = [];
  const client = new GithubClient({
    baseUrl: "https://api.github.com",
    fetch: async (url, init) => {
      seen.push(new Headers(init?.headers));
      return gh.fetch(url, init);
    },
  });
  const db = openDatabase(":memory:");
  await ensureLocalTenant(db);
  const repo = cfg().repos[0]!;
  await pollRepo({ db, github: client, provider: "docker", now: () => 1_800_000_000_000 }, repo);
  expect(seen.length).toBeGreaterThan(0);
  for (const h of seen) expect(h.has("authorization")).toBe(false);
  expect(gh.state.calls.every((c) => c.method === "GET")).toBe(true);
});

/**
 * Requests per poll cycle for one repo when nothing changed (the steady state), counted from the
 * client's own requests. GitHub answers an unchanged resource to a conditional request with 304,
 * which is not charged to the rate limit; the stub serves ETags only for the endpoints marked
 * below, so the count here is the upper bound (every request charged).
 */
test("measures the requests of one steady-state poll cycle", async () => {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  gh.state.history = [{ sha: SHA("a"), parents: [] }];
  const client = new GithubClient({
    baseUrl: "https://api.github.com",
    fetch: gh.fetch,
  });
  const db = openDatabase(":memory:");
  await ensureLocalTenant(db);
  const repo = cfg({ tagRefs: ["refs/tags/v*"] }).repos[0]!;
  const deps = { db, github: client, provider: "docker", now: () => 1_800_000_000_000 };
  await pollRepo(deps, repo); // cold: creates the run
  gh.state.calls.length = 0;
  await pollRepo(deps, repo); // warm: nothing new
  const paths = gh.state.calls.map((c) => c.path.replace(/\/repos\/acme\/web/, "")).toSorted();
  console.log(`steady-state poll cycle: ${paths.length} requests`, paths);
  expect(paths.length).toBeLessThanOrEqual(6);
});

test("measures a cycle with an open pull request from an allowed author", async () => {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  gh.state.history = [{ sha: SHA("a"), parents: [] }];
  gh.state.pulls = [{ number: 7, user: "octocat", headSha: SHA("c") }];
  gh.state.roles.set("octocat", "write");
  gh.state.compare.set(`${SHA("b")}...${SHA("c")}`, ["src/a.ts"]);
  const client = new GithubClient({ baseUrl: "https://api.github.com", fetch: gh.fetch });
  const db = openDatabase(":memory:");
  await ensureLocalTenant(db);
  const repo = cfg({ prMode: "allowlist", authors: ["octocat"] }).repos[0]!;
  const deps = { db, github: client, provider: "docker", now: () => 1_800_000_000_000 };
  await pollRepo(deps, repo);
  gh.state.calls.length = 0;
  await pollRepo(deps, repo);
  const paths = gh.state.calls.map((c) => c.path.replace(/\/repos\/acme\/web/, "")).toSorted();
  console.log(`steady-state poll cycle with one open PR: ${paths.length} requests`, paths);
  expect(paths.length).toBeLessThanOrEqual(10);
});

test("the interval that fits the anonymous budget, from the measured request counts", () => {
  // Head, protection, tag refs, open pull requests: 4 requests a cycle for one repo.
  expect(requestsPerPoll({ tagRefs: ["refs/tags/v*"], prMode: "allowlist" })).toBe(4);
  expect(requestsPerPoll({ prMode: "off" })).toBe(2);
  expect(requestsPerPoll({ tagRefs: ["a"], prMode: "approval", mergeQueue: true })).toBe(5);
  // 75% of 60 an hour: 45. Four requests a cycle needs a cycle at least every 320 seconds.
  expect(minAnonymousIntervalSeconds(4)).toBe(320);
  expect(minAnonymousIntervalSeconds(2)).toBe(160);
  // And at that interval the steady state really is under the budget.
  expect((4 * 3600) / 320).toBeLessThanOrEqual(45);
});

test("a poller with no token says what its budget is, and warns when the interval is too short", async () => {
  const logs: string[] = [];
  const gh = makeGithub();
  const db = openDatabase(":memory:");
  await ensureLocalTenant(db);
  const mk = (intervalSeconds: number) =>
    new Poller({
      db,
      config: cfg({ intervalSeconds, prMode: "allowlist", authors: ["octocat"] }),
      fetch: gh.fetch,
      log: (m) => logs.push(m),
    });
  const slow = mk(600);
  slow.start();
  await slow.stop();
  expect(logs.some((l) => l.includes("polling without a token"))).toBe(true);
  expect(logs.some((l) => l.includes("warning"))).toBe(false);
  logs.length = 0;
  const fast = mk(60);
  fast.start();
  await fast.stop();
  expect(logs.find((l) => l.includes("warning"))).toContain("intervalSeconds of at least 240");
});
