import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { githubResolver } from "@turntable/act-runner";
import { DockerProvider } from "@turntable/provider-docker";
import { ensureInstance, ensureLocalTenant, openDatabase } from "../db";
import { changedFiles, snapshotRepo } from "./repo-archive";
import { DEFAULT_IMAGE, runLocal } from "./run-local";
import { runWorkflowLocal } from "./run-workflow";
import { dbRunStore } from "./store";

export const RUN_USAGE = `Usage:
  turntable run <workflow-path> [-j <job>] [--repo <dir>] [--provider docker] [--image <ref>]
                [--data-dir ./data] [--event push] [--egress none|open]
                [--base-ref <branch>] [--action opened] [--changed-from <rev>] [--max-parallel 2]

With -j, runs that one job (no needs or matrix). Without it, runs the whole workflow: the
trigger (branches, paths) is checked for --event, jobs run in dependency order with one
sandbox each, and jobs that cannot run here (docker) or whose if: is false are skipped.
--changed-from <rev> supplies the changed files for path filters (git diff <rev> HEAD);
--base-ref and --action describe pull_request and merge_group events.
Every job runs in a fresh sandbox with act (host mode) and the run is recorded in the database.
The committed tree of --repo (git archive HEAD, plus .git) is delivered; uncommitted and
ignored files are not. Exit code: 0 success, 1 failure, 2 infra error or unrunnable workflow,
130 cancelled.`;

/** Returns the process exit code. */
export async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      j: { type: "string", short: "j" },
      repo: { type: "string" },
      provider: { type: "string", default: "docker" },
      image: { type: "string", default: DEFAULT_IMAGE },
      "data-dir": { type: "string", default: "./data" },
      event: { type: "string", default: "push" },
      egress: { type: "string", default: "none" },
      "base-ref": { type: "string" },
      action: { type: "string" },
      "changed-from": { type: "string" },
      "max-parallel": { type: "string", default: "2" },
    },
    allowPositionals: true,
    strict: true,
  });
  const [workflowArg] = positionals;
  if (!workflowArg) {
    console.error(RUN_USAGE);
    return 2;
  }
  if (values.egress !== "none" && values.egress !== "open") {
    console.error(`--egress must be none or open, got ${values.egress}`);
    return 2;
  }
  if (values.egress === "open") {
    console.error("warning: --egress open gives the sandbox network access to the internet");
  }
  if (values.provider !== "docker") {
    console.error(`unsupported --provider ${values.provider} (only docker)`);
    return 2;
  }
  const repoDir = resolve(values.repo ?? process.cwd());
  const workflowAbs = resolve(workflowArg);
  const workflowPath = relative(repoDir, workflowAbs);
  if (workflowPath.startsWith("..") || !existsSync(workflowAbs)) {
    console.error(`workflow ${workflowArg} is not inside --repo ${repoDir} or does not exist`);
    return 2;
  }

  const snap = await snapshotRepo(repoDir);
  if (snap.dirty) {
    console.error("warning: uncommitted changes are not delivered; only HEAD is run");
  }

  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      console.error("\ncancelling: destroying the sandbox (Ctrl-C again to force quit)");
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    await ensureInstance(db);
    const scope = await ensureLocalTenant(db);
    if (!values.j) {
      const files = values["changed-from"]
        ? await changedFiles(repoDir, values["changed-from"])
        : undefined;
      const wr = await runWorkflowLocal({
        provider: new DockerProvider(),
        providerName: "docker",
        store: dbRunStore(db, scope),
        workflowPath,
        workflowYaml: readFileSync(workflowAbs, "utf8"),
        event: {
          name: values.event,
          ref: snap.ref,
          ...(values["base-ref"] ? { baseRef: values["base-ref"] } : {}),
          ...(values.action ? { action: values.action } : {}),
          ...(files ? { changedFiles: files } : {}),
        },
        sha: snap.sha,
        commitMessage: snap.commitMessage,
        ...(snap.actor ? { actor: snap.actor } : {}),
        ...(snap.headBranch ? { headBranch: snap.headBranch } : {}),
        repoTarball: snap.tarball,
        image: values.image,
        out: (t) => process.stdout.write(t),
        readFile: (p) => {
          const f = join(repoDir, p);
          return existsSync(f) ? readFileSync(f, "utf8") : undefined;
        },
        egress: values.egress,
        resolver: githubResolver(),
        signal: ac.signal,
        maxParallel: Math.max(1, Number(values["max-parallel"]) || 2),
      });
      if (!wr.triggered) {
        console.error(`workflow not triggered: ${wr.triggerReason}`);
        return 0;
      }
      console.error(`\nrun ${wr.runId}: ${wr.state}`);
      for (const j of wr.jobs) console.error(`  ${j.key}: ${j.state} (${j.reason})`);
      return wr.exitCode;
    }
    const result = await runLocal({
      provider: new DockerProvider(),
      providerName: "docker",
      store: dbRunStore(db, scope),
      workflowPath,
      workflowYaml: readFileSync(workflowAbs, "utf8"),
      job: values.j,
      event: values.event,
      ref: snap.ref,
      sha: snap.sha,
      commitMessage: snap.commitMessage,
      ...(snap.actor ? { actor: snap.actor } : {}),
      ...(snap.headBranch ? { headBranch: snap.headBranch } : {}),
      repoTarball: snap.tarball,
      image: values.image,
      out: (t) => process.stdout.write(t),
      readFile: (p) => {
        const f = join(repoDir, p);
        return existsSync(f) ? readFileSync(f, "utf8") : undefined;
      },
      egress: values.egress,
      resolver: githubResolver(),
      signal: ac.signal,
    });
    console.error(`\nrun ${result.runId} job ${values.j}: ${result.state} (${result.reason})`);
    return result.exitCode;
  } catch (e) {
    // Plan errors and other failures before a run exists.
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    process.off("SIGINT", onSigint);
    db.close();
  }
}
