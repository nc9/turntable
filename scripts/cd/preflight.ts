// CD preflight: decides whether the target sha deploys or holds. All inputs are injected.
import { diffMcpTools, diffOpenApi } from "./api-surface";
import { classifyBetween, type GitShow, type MigrationClass } from "./migrations";

export interface PreflightDeps {
  show: GitShow;
  /** Paths changed between two commits. */
  changedFiles(oldSha: string, newSha: string): Promise<string[]>;
  github: {
    /** Sha of the last successful `production` deployment; null when there is none. */
    lastDeployedSha(): Promise<string | null>;
    /** Newest main commit whose CI is green. */
    newestGreenMainSha(): Promise<string>;
  };
}

export interface PreflightInput {
  targetSha: string;
  /** Conclusion of CI's aggregate check for the target. */
  ciResult: string;
  /** A maintainer's manual dispatch: migration and pipeline holds are acknowledged, not CI. */
  acknowledged?: boolean;
}

export interface PreflightResult {
  deploy: boolean;
  held: string[];
  migrations: MigrationClass[];
  deployedSha: string | null;
}

/** The file whose functions build check-run names (`checkName`, `checkScopeOf` and their text cleaner). */
export const CHECK_NAME_FILE = "packages/core/src/checks/mapping.ts";
export const OPENAPI_FILE = "docs/openapi.json";
export const MCP_TOOLS_FILE = "docs/mcp-tools.json";

/** Paths whose change since the deployed sha holds the deploy. */
export function isPipelinePath(path: string): boolean {
  return (
    path === ".github/workflows/deploy.yml" ||
    path.startsWith("scripts/cd/") ||
    path === "Dockerfile" ||
    /^railway\.[^/]+$/.test(path)
  );
}

export async function preflight(
  deps: PreflightDeps,
  input: PreflightInput,
): Promise<PreflightResult> {
  const held: string[] = [];
  let migrations: MigrationClass[] = [];
  const deployedSha = await deps.github.lastDeployedSha();

  if (input.ciResult !== "success")
    held.push(`CI for ${input.targetSha} is "${input.ciResult}", not success`);
  const newest = await deps.github.newestGreenMainSha();
  if (newest !== input.targetSha) {
    held.push(`${input.targetSha} is not the newest green main sha (${newest})`);
  }

  // Never acknowledged: a failed CI, a stale target, and an already-deployed sha.
  if (deployedSha === input.targetSha) held.push(`${input.targetSha} is already deployed`);
  const hardCount = held.length;

  const soft: string[] = [];
  if (deployedSha === null) {
    soft.push("no previous successful production deployment to compare against");
  } else if (deployedSha !== input.targetSha) {
    migrations = await classifyBetween(deps.show, deployedSha, input.targetSha);
    for (const m of migrations) {
      if (!m.additive) soft.push(`migration ${m.dialect}/${m.tag} is not additive: ${m.reason}`);
    }
    const pipeline = (await deps.changedFiles(deployedSha, input.targetSha)).filter(isPipelinePath);
    if (pipeline.length > 0) soft.push(`deploy pipeline changed: ${pipeline.join(", ")}`);
  }
  if (deployedSha !== null && deployedSha !== input.targetSha) {
    soft.push(...(await apiSurfaceHolds(deps.show, deployedSha, input.targetSha)));
  }
  if (!input.acknowledged) held.push(...soft);

  return { deploy: hardCount === 0 && held.length === 0, held, migrations, deployedSha };
}

const parse = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Holds for a change to the agent-facing surface between two commits: the OpenAPI document and the
 * MCP tool list for the watched operations (see api-surface.ts), and the check-run name builder.
 * A document missing at either commit cannot be compared, which is itself a hold.
 */
export async function apiSurfaceHolds(
  show: GitShow,
  oldSha: string,
  newSha: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const [file, diff, label] of [
    [OPENAPI_FILE, diffOpenApi, "API surface"],
    [MCP_TOOLS_FILE, diffMcpTools, "MCP tool surface"],
  ] as const) {
    const [a, b] = [parse(await show(oldSha, file)), parse(await show(newSha, file))];
    if (a === undefined || b === undefined) {
      out.push(
        `${label}: ${file} cannot be compared (missing at ${a === undefined ? "the deployed" : "the target"} commit)`,
      );
      continue;
    }
    for (const reason of diff(a, b)) out.push(`${label} changed: ${reason}`);
  }
  const [oldNames, newNames] = [
    await show(oldSha, CHECK_NAME_FILE),
    await show(newSha, CHECK_NAME_FILE),
  ];
  if (oldNames !== newNames) out.push(`check-run name builder changed: ${CHECK_NAME_FILE}`);
  return out;
}
