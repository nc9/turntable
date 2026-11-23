// `longshore parity`: compares one of our runs with the check runs another CI's GitHub App posted
// for the same commit, job by job. Read-only on both sides. See docs/parity.mdx.
import { parseArgs } from "node:util";
import type { SafeFetch } from "@longshore/net";
import { parseBaseUrl } from "../channel/api";
import { readTokenFile } from "../mcp/stdio";
import { fetchOurRun, fetchTheirChecks } from "./api";
import { compareParity, renderParity } from "./compare";

export const PARITY_USAGE = `Usage: longshore parity --run <id> --repo <owner/name> --app-id <n> [--json]
                        [--url <https://host>] [--org <slug>] [--token-file <path>]
                        [--github-token-file <path>] [--github-url <https://api.github.com>]

Compares one of our runs with the check runs a GitHub App posted for the same commit, job by job:
our state and duration against theirs, a MATCH or DIVERGE verdict, divergences first.
  - our \`skipped\` equals their \`success\` when our job was gated off by its \`if:\` (the reason is shown);
  - their contexts we do not run are listed as "not ours", our jobs they do not post as "not reported".
--app-id is the numeric id of the App whose check runs are the oracle. Our side is read with a
reader token (--token-file or LONGSHORE_TOKEN_FILE, mode 0600; --url / LONGSHORE_URL, --org /
LONGSHORE_ORG). GitHub is read without a token unless --github-token-file (or
LONGSHORE_GITHUB_TOKEN_FILE) names a file holding one; no token is ever taken from the command line.
Exit status: 0 when nothing diverges, 1 when something does, 2 on a usage or request error.`;

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
  if (!run) return bad("pass --run");
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
    const mine = await fetchOurRun({
      baseUrl,
      org,
      token,
      runId: run,
      ...(deps.ours ? { fetch: deps.ours } : {}),
    });
    if (!mine.sha) return bad("our run has no commit sha to compare at");
    const theirs = await fetchTheirChecks({
      githubUrl,
      repo,
      sha: mine.sha,
      appId,
      token: githubToken,
      ...(deps.github ? { fetch: deps.github } : {}),
    });
    const report = compareParity(mine.jobs, theirs);
    out(
      values.json
        ? JSON.stringify({ run: mine.id, sha: mine.sha, repo, appId, ...report }, null, 2)
        : renderParity(report, { run: mine.id, sha: mine.sha }),
    );
    return report.totals.diverge > 0 ? 1 : 0;
  } catch (e) {
    console.error(`longshore parity: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
