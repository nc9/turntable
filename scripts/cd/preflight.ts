// CD preflight: decides whether the target sha deploys or holds. All inputs are injected.
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
  if (!input.acknowledged) held.push(...soft);

  return { deploy: hardCount === 0 && held.length === 0, held, migrations, deployedSha };
}
