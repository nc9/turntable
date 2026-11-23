import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareParity,
  gatedBy,
  normOurs,
  normTheirs,
  renderParity,
  type OurJob,
  type TheirCheck,
} from "../src/parity/compare";
import { fetchOurRun } from "../src/parity/api";
import { parityCommand } from "../src/parity/cli";

const SHA = "1e179448b7b7f4976726df1abdb50178ae46f67e";

const ours: OurJob[] = [
  { name: "Format, lint, and typecheck", state: "success", durationMs: 100_000 },
  { name: "CLI tests", state: "failure", durationMs: 240_000 },
  {
    name: "Release tooling tests",
    state: "skipped",
    durationMs: null,
    skipReason: "if: needs.changes.outputs.release != 'false' is false",
  },
  {
    name: "Installer script syntax",
    state: "skipped",
    durationMs: null,
    skipReason: "unsupported: docker",
  },
  { name: "Docs check and build", state: "success", durationMs: 60_000 },
  { name: "Compile CLI", state: "running", durationMs: null },
  { name: "audit engine golden tests", state: "success", durationMs: 30_000 },
  { name: "Local only job", state: "success", durationMs: 1000 },
];
const done = (name: string, conclusion: string, durationMs: number | null): TheirCheck => ({
  name,
  status: "completed",
  conclusion,
  durationMs,
});
const theirs: TheirCheck[] = [
  done("Format, lint, and typecheck", "success", 95_000),
  done("CLI tests", "success", 250_000),
  done("Release tooling tests", "success", 3_000),
  done("Installer script syntax", "success", 5_000),
  done("Docs check and build", "skipped", null),
  done("Compile CLI", "success", 400_000),
  done("Audit engine golden tests", "success", 31_000),
  done("CodeQL", "success", 900_000),
];

describe("normalising conclusions", () => {
  test("ours and theirs reduce to the same few words", () => {
    expect(normOurs("infra_error")).toBe("error");
    expect(normOurs("awaiting_approval")).toBe("pending");
    expect(normTheirs("completed", "neutral")).toBe("skipped");
    expect(normTheirs("completed", "timed_out")).toBe("failure");
    expect(normTheirs("in_progress", null)).toBe("pending");
    expect(normTheirs("completed", "action_required")).toBe("error");
  });
  test("only an if: that evaluated false gates a job", () => {
    expect(gatedBy("if: success() is false")).toBe("success()");
    expect(gatedBy("if: needs.a.result == 'x' is false")).toBe("needs.a.result == 'x'");
    expect(gatedBy("unsupported: docker")).toBeUndefined();
    expect(gatedBy("cannot evaluate if: bad")).toBeUndefined();
    expect(gatedBy(null)).toBeUndefined();
  });
});

describe("comparing a run with another CI's checks", () => {
  const r = compareParity(ours, theirs);
  const by = (job: string) => r.rows.find((x) => x.job === job)!;

  test("matching conclusions match, and names pair case-insensitively", () => {
    expect(by("Format, lint, and typecheck")).toMatchObject({ verdict: "MATCH" });
    expect(by("audit engine golden tests")).toMatchObject({ verdict: "MATCH" });
  });

  test("a skip by an if: equals their success, and says why", () => {
    const row = by("Release tooling tests");
    expect(row.verdict).toBe("MATCH");
    expect(row.note).toContain("needs.changes.outputs.release != 'false'");
  });

  test("a skip for any other reason does not", () => {
    expect(by("Installer script syntax")).toMatchObject({ verdict: "DIVERGE" });
    expect(by("Installer script syntax").note).toContain("unsupported: docker");
  });

  test("differing conclusions diverge, and a skipped theirs is not a success of ours", () => {
    expect(by("CLI tests")).toMatchObject({
      verdict: "DIVERGE",
      note: "ours failure, theirs success",
    });
    expect(by("Docs check and build")).toMatchObject({ verdict: "DIVERGE" });
  });

  test("a job still running is pending, not a divergence", () => {
    expect(by("Compile CLI")).toMatchObject({ verdict: "PENDING" });
  });

  test("divergences come first, then pending, then matches", () => {
    expect(r.rows.map((x) => x.verdict)).toEqual([
      "DIVERGE",
      "DIVERGE",
      "DIVERGE",
      "PENDING",
      "MATCH",
      "MATCH",
      "MATCH",
    ]);
  });

  test("contexts only they run, and jobs only we run, are listed apart", () => {
    expect(r.notOurs.map((x) => x.name)).toEqual(["CodeQL"]);
    expect(r.notReported.map((x) => x.name)).toEqual(["Local only job"]);
  });

  test("totals", () => {
    expect(r.totals).toEqual({
      match: 3,
      diverge: 3,
      pending: 1,
      gatedSkips: 1,
      notOurs: 1,
      notReported: 1,
    });
  });

  test("the table puts divergences first and ends with the totals", () => {
    const text = renderParity(r, { run: "run1", sha: SHA });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`parity for run run1 at ${SHA.slice(0, 12)}`);
    expect(text.indexOf("DIVERGE")).toBeLessThan(text.indexOf("MATCH"));
    expect(text).toContain("not ours (they report a context we do not run):");
    expect(text).toContain("not reported (our job, no matching check from them):");
    expect(lines.at(-1)).toBe(
      "3 match (1 by the gated-skip rule), 3 diverge, 1 pending, 1 not ours, 1 not reported",
    );
  });

  test("two jobs with one name pair with two checks, in order", () => {
    const rr = compareParity(
      [
        { name: "build", state: "success", durationMs: 1 },
        { name: "build", state: "failure", durationMs: 1 },
      ],
      [done("build", "success", 1), done("build", "failure", 1)],
    );
    expect(rr.totals).toMatchObject({ match: 2, diverge: 0 });
  });
});

describe("the command", () => {
  let dir: string;
  let tokenFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ls-parity-"));
    tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "tt_reader_example_token_value\n", { mode: 0o600 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const seen: { url: string; auth: string | null }[] = [];
  const oursFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    seen.push({
      url: u.pathname + u.search,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (u.pathname === "/api/v1/runs/run1")
      return json({
        id: "run1",
        sha: SHA,
        jobs: [
          { id: "j1", name: "build", state: "success", duration_ms: 1000 },
          { id: "j2", name: "release", state: "skipped", duration_ms: null },
        ],
      });
    if (u.pathname === "/api/v1/jobs/j2/log")
      return json({ text: "skipped: if: needs.changes.outputs.release != 'false' is false\n" });
    return new Response("{}", { status: 404 });
  };
  const checks = (appId: number) => ({
    check_runs: [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-22T22:00:00Z",
        completed_at: "2026-11-22T22:00:02Z",
        app: { id: appId },
      },
      { name: "release", status: "completed", conclusion: "success", app: { id: appId } },
      // another App's check on the same commit: not the oracle
      { name: "other", status: "completed", conclusion: "failure", app: { id: 999 } },
    ],
  });
  const githubFetch = async (input: string | URL | Request) => {
    const u = new URL(String(input));
    seen.push({ url: u.host + u.pathname, auth: null });
    return u.pathname === `/repos/acme/web/commits/${SHA}/check-runs`
      ? json(checks(4242))
      : new Response("{}", { status: 404 });
  };
  const base = () => [
    "--run",
    "run1",
    "--repo",
    "acme/web",
    "--app-id",
    "4242",
    "--url",
    "http://127.0.0.1:1",
    "--org",
    "acme",
    "--token-file",
    tokenFile,
  ];

  test("reads our run and their checks for its sha, reports a match, exits 0", async () => {
    seen.length = 0;
    let text = "";
    const code = await parityCommand(base(), {
      ours: oursFetch,
      github: githubFetch,
      out: (s) => (text = s),
    });
    expect(code).toBe(0);
    expect(text).toContain("2 match (1 by the gated-skip rule), 0 diverge");
    expect(text).toContain("needs.changes.outputs.release != 'false'");
    expect(text).not.toContain("other");
    // the token went only to our server, as a header; GitHub got none; nothing was written
    expect(
      seen
        .filter((s) => s.auth !== null)
        .every((s) => s.auth === "Bearer tt_reader_example_token_value"),
    ).toBe(true);
    expect(seen.some((s) => s.url.startsWith("api.github.com") && s.auth !== null)).toBe(false);
  });

  test("--json is the whole report, and a divergence exits 1", async () => {
    let text = "";
    const code = await parityCommand([...base(), "--json"], {
      ours: oursFetch,
      github: async (input) => {
        const u = new URL(String(input));
        void u;
        return json({
          check_runs: [
            { name: "build", status: "completed", conclusion: "failure", app: { id: 4242 } },
          ],
        });
      },
      out: (s) => (text = s),
    });
    expect(code).toBe(1);
    const r = JSON.parse(text);
    expect(r).toMatchObject({ run: "run1", sha: SHA, repo: "acme/web", appId: 4242 });
    expect(r.totals).toMatchObject({ diverge: 1, notReported: 1 });
    expect(r.rows[0]).toMatchObject({ job: "build", verdict: "DIVERGE" });
  });

  test("a missing or bad option is a usage error, exit 2", async () => {
    const quiet = { out: () => {} };
    expect(await parityCommand(["--run", "r"], quiet)).toBe(2);
    // a repo that is not owner/name, and an app id that is not a number
    expect(await parityCommand(["--run", "r", "--repo", "x", "--app-id", "1"], quiet)).toBe(2);
    expect(await parityCommand(["--run", "r", "--repo", "a/b", "--app-id", "abc"], quiet)).toBe(2);
    // our server says no: reported, exit 2
    const code = await parityCommand(base(), {
      ours: async () => new Response("{}", { status: 404 }),
      github: githubFetch,
      ...quiet,
    });
    expect(code).toBe(2);
  });

  describe("--last: one line per sha", () => {
    const S = (c: string) => c.repeat(40);
    // newest first: S(a) twice (a rerun), S(b), S(c), S(d)
    const listed = [
      { id: "ra2", sha: S("a"), state: "success" },
      { id: "ra1", sha: S("a"), state: "failure" },
      { id: "rb", sha: S("b"), state: "success" },
      { id: "rc", sha: S("c"), state: "running" },
      { id: "rd", sha: S("d"), state: "success" },
    ];
    const jobsOf: Record<string, { state: string }> = {
      ra2: { state: "success" },
      rb: { state: "success" },
      rc: { state: "running" },
      rd: { state: "success" },
    };
    // theirs: a ok, b failed (diverges with our success), c ok (ours is still running), d none
    const theirsBySha: Record<string, string | undefined> = {
      [S("a")]: "success",
      [S("b")]: "failure",
      [S("c")]: "success",
    };
    const calls: string[] = [];
    const lastOurs = async (input: string | URL | Request) => {
      const u = new URL(String(input));
      calls.push(u.pathname + u.search);
      if (u.pathname === "/api/v1/runs") return json({ runs: listed });
      const m = /^\/api\/v1\/runs\/(\w+)$/.exec(u.pathname);
      if (m) {
        const id = m[1] as string;
        const r = listed.find((x) => x.id === id)!;
        return json({
          id,
          sha: r.sha,
          jobs: [
            { id: `${id}-j`, name: "build", state: jobsOf[id]?.state ?? "success", duration_ms: 5 },
          ],
        });
      }
      return new Response("{}", { status: 404 });
    };
    const lastGithub = async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const sha = /commits\/(\w{40})\/check-runs/.exec(u.pathname)?.[1] ?? "";
      const conclusion = theirsBySha[sha];
      return json({
        check_runs: conclusion
          ? [{ name: "build", status: "completed", conclusion, app: { id: 4242 } }]
          : [],
      });
    };
    const lastArgs = (n: string, ...more: string[]) => [
      "--last",
      n,
      "--branch",
      "main",
      "--event",
      "push",
      "--repo",
      "acme/web",
      "--app-id",
      "4242",
      "--url",
      "http://127.0.0.1:1",
      "--org",
      "acme",
      "--token-file",
      tokenFile,
      ...more,
    ];

    test("lists the newest runs with the branch and event, dedupes by sha, and prints a verdict per sha", async () => {
      calls.length = 0;
      let text = "";
      const code = await parityCommand(lastArgs("4"), {
        ours: lastOurs,
        github: lastGithub,
        out: (s) => (text = s),
      });
      const lines = text.split("\n");
      expect(lines).toHaveLength(4);
      // newest first, the newest run of a sha only (ra2, not its rerun ra1)
      expect(lines[0]).toStartWith(`${S("a").slice(0, 12)}  match  `);
      expect(lines[0]).toContain("run ra2");
      expect(lines[1]).toStartWith(`${S("b").slice(0, 12)}  1 diverge  `);
      expect(lines[2]).toStartWith(`${S("c").slice(0, 12)}  pending  `);
      // no check from them at all for d: nothing paired yet, so pending, not a divergence
      expect(lines[3]).toStartWith(`${S("d").slice(0, 12)}  pending  `);
      expect(code).toBe(1);
      const list = calls.find((c) => c.startsWith("/api/v1/runs?"))!;
      expect(list).toContain("branch=main");
      expect(list).toContain("event=push");
      expect(list).toContain("limit=12");
      // each sha's run is read once; the rerun ra1 was never fetched
      expect(calls.some((c) => c.endsWith("/runs/ra1"))).toBe(false);
    });

    test("N cuts the list, --json is an array, and no divergence exits 0", async () => {
      let text = "";
      const code = await parityCommand(lastArgs("1", "--json"), {
        ours: lastOurs,
        github: lastGithub,
        out: (s) => (text = s),
      });
      const arr = JSON.parse(text);
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toHaveLength(1);
      expect(arr[0]).toMatchObject({ run: "ra2", sha: S("a"), verdict: "match", summary: "match" });
      expect(arr[0].totals).toMatchObject({ match: 1, diverge: 0 });
      expect(code).toBe(0);
    });

    test("usage errors: both --run and --last, neither, a bad N, filters without --last", async () => {
      const quiet = { out: () => {}, ours: lastOurs, github: lastGithub };
      expect(await parityCommand([...lastArgs("2"), "--run", "r"], quiet)).toBe(2);
      expect(await parityCommand(lastArgs("0"), quiet)).toBe(2);
      expect(await parityCommand(lastArgs("51"), quiet)).toBe(2);
      expect(await parityCommand(lastArgs("x"), quiet)).toBe(2);
      expect(await parityCommand([...base(), "--branch", "main"], quiet)).toBe(2);
    });

    test("no runs matching prints that, and is not a failure", async () => {
      let text = "";
      const code = await parityCommand(lastArgs("3"), {
        ours: async () => json({ runs: [] }),
        github: lastGithub,
        out: (s) => (text = s),
      });
      expect(text).toBe("no runs");
      expect(code).toBe(0);
    });
  });
});

describe("the shards of a split job are one job", () => {
  const shard = (i: number, state: string, start: string | null, end: string | null) => ({
    id: `s${i}`,
    name: "CLI tests (rules, engine and the rest)",
    state,
    duration_ms: start && end ? Date.parse(end) - Date.parse(start) : null,
    started_at: start,
    finished_at: end,
    shard: { job: "tests", index: i, total: 3 },
  });
  const runWith = (jobs: unknown[]) => async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/v1/runs/r1") {
      return new Response(JSON.stringify({ id: "r1", sha: SHA, jobs }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname.endsWith("/log"))
      return new Response(JSON.stringify({ text: "skipped: if: false is false\n" }), {
        headers: { "content-type": "application/json" },
      });
    return new Response("{}", { status: 404 });
  };
  const get = (jobs: unknown[]) =>
    fetchOurRun({
      baseUrl: new URL("http://127.0.0.1:1"),
      org: "acme",
      token: "tt_reader_example_token_value",
      runId: "r1",
      fetch: runWith(jobs) as never,
    });

  test("three shards report as one job: the fold of their states and the wall time, not the sum", async () => {
    const r = await get([
      { id: "j0", name: "Format", state: "success", duration_ms: 1000, shard: null },
      shard(0, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:06:00Z"),
      shard(1, "success", "2026-11-23T10:00:10Z", "2026-11-23T10:03:00Z"),
      shard(2, "success", "2026-11-23T10:00:05Z", "2026-11-23T10:02:00Z"),
    ]);
    expect(r.jobs.map((j) => j.name)).toEqual(["Format", "CLI tests (rules, engine and the rest)"]);
    expect(r.jobs[1]).toMatchObject({ state: "success", durationMs: 6 * 60_000 });
  });

  test("any failed shard fails the job; a shard still running leaves it running with no duration", async () => {
    const failed = await get([
      shard(0, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:06:00Z"),
      shard(1, "failure", "2026-11-23T10:00:00Z", "2026-11-23T10:01:00Z"),
      shard(2, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:02:00Z"),
    ]);
    expect(failed.jobs).toHaveLength(1);
    expect(failed.jobs[0]!.state).toBe("failure");
    const running = await get([
      shard(0, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:06:00Z"),
      shard(1, "running", "2026-11-23T10:00:00Z", null),
    ]);
    expect(running.jobs[0]).toMatchObject({ state: "running", durationMs: null });
  });

  test("a split job compares against the one check of that name", async () => {
    const r = await get([
      shard(0, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:06:00Z"),
      shard(1, "success", "2026-11-23T10:00:00Z", "2026-11-23T10:03:00Z"),
    ]);
    const rep = compareParity(r.jobs, [
      done("CLI tests (rules, engine and the rest)", "success", 400_000),
    ]);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]).toMatchObject({ verdict: "MATCH", oursDurationMs: 360_000 });
    expect(rep.notReported).toEqual([]);
  });

  test("all shards skipped by an if: is one skipped job with that reason", async () => {
    const r = await get([
      { ...shard(0, "skipped", null, null) },
      { ...shard(1, "skipped", null, null) },
    ]);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ state: "skipped", skipReason: "if: false is false" });
  });
});
