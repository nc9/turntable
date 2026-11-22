import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { githubResolver } from "@turntable/act-runner";
import { DockerProvider } from "@turntable/provider-docker";
import { ensureInstance, ensureLocalTenant, openDatabase } from "../db";
import { snapshotRepo } from "./repo-archive";
import { DEFAULT_IMAGE, runLocal } from "./run-local";
import { dbRunStore } from "./store";

export const RUN_USAGE = `Usage:
  turntable run <workflow-path> -j <job> [--repo <dir>] [--provider docker] [--image <ref>]
                [--data-dir ./data] [--event push] [--egress none|open]

Runs one job in a fresh sandbox with act (host mode) and records the run in the database.
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
    },
    allowPositionals: true,
    strict: true,
  });
  const [workflowArg] = positionals;
  if (!workflowArg || !values.j) {
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
