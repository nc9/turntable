// `longshore parity`: compares one of our runs with the check runs another CI's GitHub App posted
// for the same commit, job by job. Read-only on both sides. See docs/parity.mdx.
import { parseArgs } from "node:util";
import type { SafeFetch } from "@longshore/net";
import { parseBaseUrl } from "../channel/api";
import { readTokenFile } from "../mcp/stdio";
import { fetchOurRun, fetchTheirChecks, listOurRuns } from "./api";
import { compareParity, renderParity, verdictOf } from "./compare";

export const PARITY_USAGE = `Usage: longshore parity --run <id> --repo <owner/name> --app-id <n> [--json]
       longshore parity --last <n> [--branch main] [--event push] --repo <owner/name> --app-id <n> [--json]
                        [--url <https://host>] [--org <slug>] [--token-file <path>]
                        [--github-token-file <path>] [--github-url <https://api.github.com>]

Compares one of our runs with the check runs a GitHub App posted for the same commit, job by job:
our state and duration against theirs, a MATCH or DIVERGE verdict, divergences first.
  - our \`skipped\` equals their \`success\` when our job was gated off by its \`if:\` (the reason is shown);
  - their contexts we do not run are listed as "not ours", our jobs they do not post as "not reported".
--last <n> compares the newest n runs instead of one (--branch and --event narrow them; run
  --branch main --event push for "the last n commits of main"), one run per commit, and prints one
  line per sha: match, "<k> diverge" or pending. With --json it prints an array.
--app-id is the numeric id of the App whose check runs are the oracle. Our side is read with a
reader token (--token-file or LONGSHORE_TOKEN_FILE, mode 0600; --url / LONGSHORE_URL, --org /
LONGSHORE_ORG). GitHub is read without a token unless --github-token-file (or
LONGSHORE_GITHUB_TOKEN_FILE) names a file holding one; no token is ever taken from the command line.
Exit status: 0 when nothing diverges, 1 when something does (in any sha), 2 on a usage or request error.`;

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export async function parityCommand(
  args: string[],
  deps: { ours?: SafeFetch; github?: SafeFetch; out?: (s: string) => void } = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const { values } = parseArgs({
    args,
    options: {
      run: { type: "string" },
      last: { type: "string" },
      branch: { type: "string" },
      event: { type: "string" },
      repo: { type: "string" },
      "app-id": { type: "string" },
      json: { type: "boolean", default: false },
      url: { type: "string" },
      org: { type: "string" },
      "token-file": { type: "string" },
      "github-token-file": { type: "string" },
      "github-url": { type: "string" },
      "allow-insecure": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    out(PARITY_USAGE);
    return 0;
  }
  const bad = (m: string): number => {
    console.error(`longshore parity: ${m}\n\n${PARITY_USAGE}`);
    return 2;
  };
  const run = values.run;
  const repo = values.repo;
  const last = values.last === undefined ? undefined : Number(values.last);
  if (run !== undefined && last !== undefined) return bad("pass --run or --last, not both");
  if (last !== undefined && (!Number.isInteger(last) || last < 1 || last > 50))
    return bad("--last must be a whole number from 1 to 50");
  if (run === undefined && last === undefined) return bad("pass --run or --last");
  if (last === undefined && (values.branch !== undefined || values.event !== undefined))
    return bad("--branch and --event go with --last");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    return bad("pass --repo owner/name");
  const appId = Number(values["app-id"]);
  if (!Number.isInteger(appId) || appId <= 0) return bad("pass --app-id <positive integer>");
  const url = values.url ?? env("LONGSHORE_URL");
  const org = values.org ?? env("LONGSHORE_ORG");
  const tokenFile = values["token-file"] ?? env("LONGSHORE_TOKEN_FILE");
  if (!url) return bad("no server: pass --url or set LONGSHORE_URL");
  if (!org) return bad("no org: pass --org or set LONGSHORE_ORG");
  if (!tokenFile) return bad("no token file: pass --token-file or set LONGSHORE_TOKEN_FILE");
  try {
    const baseUrl = parseBaseUrl(url, values["allow-insecure"]);
    const token = readTokenFile(tokenFile);
    const ghFile = values["github-token-file"] ?? env("LONGSHORE_GITHUB_TOKEN_FILE");
    const githubToken = ghFile ? readTokenFile(ghFile) : undefined;
    const githubUrl = new URL(values["github-url"] ?? "https://api.github.com");
    const compareOne = async (
      runId: string,
    ): Promise<
      { id: string; sha: string; report: ReturnType<typeof compareParity> } | undefined
    > => {
      const mine = await fetchOurRun({
        baseUrl,
        org,
        token,
        runId,
        ...(deps.ours ? { fetch: deps.ours } : {}),
      });
      if (!mine.sha) return undefined;
      const theirs = await fetchTheirChecks({
        githubUrl,
        repo,
        sha: mine.sha,
        appId,
        token: githubToken,
        ...(deps.github ? { fetch: deps.github } : {}),
      });
      return { id: mine.id, sha: mine.sha, report: compareParity(mine.jobs, theirs) };
    };

    if (last !== undefined) {
      // The newest run of each commit (a commit can have several), newest commits first. One page
      // is asked for with room for reruns, then cut to `last` shas.
      const listed = await listOurRuns({
        baseUrl,
        org,
        token,
        branch: values.branch,
        event: values.event,
        limit: Math.min(100, last * 3),
        ...(deps.ours ? { fetch: deps.ours } : {}),
      });
      const seenSha = new Set<string>();
      const picks = listed
        .filter((r) => r.sha !== null && !seenSha.has(r.sha) && !!seenSha.add(r.sha))
        .slice(0, last);
      const rows: {
        run: string;
        sha: string;
        verdict: string;
        summary: string;
        totals: ReturnType<typeof compareParity>["totals"];
      }[] = [];
      for (const r of picks) {
        const one = await compareOne(r.id);
        if (!one) continue;
        rows.push({
          run: one.id,
          sha: one.sha,
          verdict: verdictOf(one.report).word,
          summary: verdictOf(one.report).text,
          totals: one.report.totals,
        });
      }
      const text = (r: (typeof rows)[number]): string =>
        `${r.sha.slice(0, 12)}  ${r.summary}  (${r.totals.match} match, ${r.totals.diverge} diverge, ${r.totals.pending} pending, run ${r.run})`;
      out(values.json ? JSON.stringify(rows, null, 2) : rows.map(text).join("\n") || "no runs");
      return rows.some((r) => r.totals.diverge > 0) ? 1 : 0;
    }

    const one = await compareOne(run as string);
    if (!one) return bad("our run has no commit sha to compare at");
    out(
      values.json
        ? JSON.stringify({ run: one.id, sha: one.sha, repo, appId, ...one.report }, null, 2)
        : renderParity(one.report, { run: one.id, sha: one.sha }),
    );
    return one.report.totals.diverge > 0 ? 1 : 0;
  } catch (e) {
    console.error(`longshore parity: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
