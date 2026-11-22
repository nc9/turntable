import { readFileSync } from "node:fs";
import { z } from "zod";

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name");

/**
 * Poll config. Strict: an unknown key is an error, so a typo cannot silently weaken the gate and
 * a secret pasted inline (`token`) is refused. The token lives in a file named by `tokenFile`.
 */
export const pollConfigSchema = z
  .object({
    /**
     * File holding a GitHub token (mode 0600, outside the repo). Required: polling is
     * authenticated so the rate limit is not shared with every other unauthenticated client.
     */
    tokenFile: z.string().min(1).optional(),
    /**
     * Name of an environment variable holding the token, for a platform with no shell and no
     * files (Railway). The config never carries the token itself, only this name.
     */
    tokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "an environment variable name")
      .optional(),
    /** Explicitly allow polling with no token (tests, a tiny setup). Default false. */
    allowUnauthenticated: z.boolean().default(false),
    /** For tests and GitHub Enterprise. */
    apiBaseUrl: z.url().default("https://api.github.com"),
    /** Provider name stamped on the attempts the poller creates. */
    provider: z.string().min(1).default("docker"),
    repos: z
      .array(
        z
          .object({
            repo: repoName,
            /** Where runs land. Default: the built-in local org and project. */
            org: z.string().min(1).default("local"),
            project: z.string().min(1).default("local"),
            workflow: z.string().min(1).describe("Workflow path, e.g. .github/workflows/ci.yml"),
            defaultBranch: z.string().min(1),
            /** Seconds between polls of this repo. 60 to 120 is the intended range. */
            intervalSeconds: z.int().min(30).max(3600).default(60),
            /**
             * `off`: pull requests are never run. `allowlist`: only same-repo PRs by listed authors
             * run, and nothing else is looked at. `approval`: every open PR is ingested and its
             * trust class decided from re-fetched facts (same repo, and the author's collaborator
             * permission); an untrusted class is created but waits in awaiting_approval until a
             * maintainer approves that sha. Listed `authors` count as trusted in both modes.
             */
            prMode: z.enum(["off", "allowlist", "approval"]).default("off"),
            /**
             * Only these pull request numbers are considered (both PR modes). Unset: every open
             * pull request. For targeted parity runs without picking up every open PR.
             */
            prNumbers: z.array(z.int().positive()).max(100).optional(),
            /**
             * Ingest merge queue runs (`merge_group`). Each poll lists the repo's
             * `gh-readonly-queue/<defaultBranch>/` branches and runs one only when it is a verified
             * GitHub-made commit for an open same-repo PR by a listed author. Off by default.
             */
            mergeQueue: z.boolean().default(false),
            /** GitHub logins trusted without asking the forge. Compared case-insensitively. */
            authors: z.array(z.string().min(1)).default([]),
            /** Extra protected ref patterns (refs/heads/release/**). The default branch always is. */
            protectedRefs: z.array(z.string().min(1)).default([]),
            /**
             * Sandbox egress for this repo's runs: `none`, `open` or `allowlist`. Unset: the
             * project's setting (`projects.egress`), which defaults to `none`.
             */
            egress: z.enum(["none", "open", "allowlist"]).optional(),
            /**
             * Egress for runs classified untrusted_pr, whatever `egress` says: never `open`
             * (untrusted code with network is a mining and exfiltration vector). Default `none`.
             */
            untrustedEgress: z.enum(["none", "allowlist"]).default("none"),
            /**
             * Most pull requests from authors who are not on `authors` that one poll will look at
             * (each costs forge API calls). The rest wait for the next poll.
             */
            maxNewPrsPerPoll: z.int().min(1).max(100).default(5),
            /** Most runs of this repo that may wait for approval at once. */
            maxWaitingRuns: z.int().min(1).max(500).default(20),
            maxRunsPerHour: z.int().min(1).max(1000).default(30),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((c) => c.tokenFile === undefined || c.tokenEnv === undefined, {
    path: ["tokenEnv"],
    message: "set only one of tokenFile and tokenEnv",
  })
  .refine((c) => c.tokenFile !== undefined || c.tokenEnv !== undefined || c.allowUnauthenticated, {
    path: ["tokenFile"],
    message:
      "required (polling must be authenticated): tokenFile or tokenEnv; set allowUnauthenticated to opt out",
  });

export type PollConfig = z.infer<typeof pollConfigSchema>;
export type PollRepoConfig = PollConfig["repos"][number];

/** Validates poll config text. Errors name the source and the field, never a secret. */
export function parsePollConfig(text: string, source: string): PollConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `cannot read poll config ${source}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  const parsed = pollConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid poll config ${source}:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

/** Parses a config file. */
export function loadPollConfig(path: string): PollConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read poll config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  return parsePollConfig(text, path);
}

/** The poll token from its file or its environment variable; undefined when neither is set. */
export function readPollToken(
  c: { tokenFile?: string | undefined; tokenEnv?: string | undefined },
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (c.tokenFile) return readToken(c.tokenFile);
  if (c.tokenEnv) {
    const v = env[c.tokenEnv]?.trim();
    if (!v) throw new Error(`environment variable ${c.tokenEnv} (the poll token) is not set`);
    return v;
  }
  return undefined;
}

/** Reads the token file, trimmed. Errors never include the content. */
export function readToken(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`cannot read token file ${path}`);
  }
  if (text === "") throw new Error(`token file ${path} is empty`);
  return text;
}
