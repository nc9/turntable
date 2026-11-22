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
            /** `off`: pull requests are never run. `allowlist`: same-repo PRs by listed authors. */
            prMode: z.enum(["off", "allowlist"]).default("off"),
            /** GitHub logins allowed to have PRs run. Compared case-insensitively. */
            authors: z.array(z.string().min(1)).default([]),
            maxRunsPerHour: z.int().min(1).max(1000).default(30),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((c) => c.tokenFile !== undefined || c.allowUnauthenticated, {
    path: ["tokenFile"],
    message: "required (polling must be authenticated); set allowUnauthenticated to opt out",
  });

export type PollConfig = z.infer<typeof pollConfigSchema>;
export type PollRepoConfig = PollConfig["repos"][number];

/** Parses a config file. Errors name the file and the field, never a secret. */
export function loadPollConfig(path: string): PollConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read poll config ${path}: ${err instanceof Error ? err.message : "error"}`,
    );
  }
  const parsed = pollConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid poll config ${path}:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
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
