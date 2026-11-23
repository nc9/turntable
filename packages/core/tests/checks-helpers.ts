import {
  appendLog,
  bindRepo,
  createAttempt,
  createJob,
  createProject,
  createRun,
  upsertStep,
} from "../src/db";
import type { Db } from "../src/db";
import type { Claim } from "../src/db/repos";
import { setup } from "./github-helpers";

/** An org with an installed repo `acme/web`, a project, and a way to mint claims on it. */
export async function setupChecksWorld(open?: () => Db) {
  const { db, org, store } = await setup(undefined, open);
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  const scope = { orgId: org.id, projectId: project.id };
  const installationId = "9001";
  await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web", installationId });
  const sha = "a".repeat(40);

  async function claim(): Promise<Claim> {
    const run = await createRun(db, scope, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
      sha,
      repo: "acme/web",
    });
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
    const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
    return { attempt, job, run, scope };
  }

  /** A failing step with a log, as the runner would have recorded it. */
  async function addFailingLog(c: Claim, step: string, log?: string): Promise<void> {
    const text = log ?? "setup\nexpected 1 to be 2\nerror: assertion failed\n";
    const body = `prelude\n${text}`;
    await appendLog(db, scope, c.attempt.id, 0, new TextEncoder().encode(body));
    await upsertStep(db, scope, {
      attemptId: c.attempt.id,
      stepKey: "s0",
      stage: "main",
      index: 0,
      name: step,
      result: "failure",
      startedAt: null,
      finishedAt: null,
      logOffset: 0,
    });
  }

  return { db, org, store, scope, installationId, sha, claim, addFailingLog };
}
