import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drain,
  planJob,
  rebuildArgv,
  resolveActions,
  runJob,
  staticResolver,
  tarDirectory,
} from "@turntable/act-runner";
import { DockerProvider } from "@turntable/provider-docker";
import { SecretRegistry, redactString } from "@turntable/redact";
import { eq } from "drizzle-orm";
import { ArtifactGrants } from "../src/artifacts/grants";
import { jobArtifactProvider } from "../src/artifacts/job";
import { createArtifactService } from "../src/artifacts/service";
import { FsArtifactStore } from "../src/artifacts/store";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  listRunArtifacts,
  openDatabase,
} from "../src/db";
import * as s from "../src/db/schema";
import { startServer } from "../src/server";
import type { TrustClass } from "../src/trust";

// CI only (TT_ARTIFACTS_E2E=1): needs Docker, network for the pinned act download and the pinned
// actions, and an image with bash, git, node and coreutils (node:22-bookworm). Real act runs
// real actions/upload-artifact and download-artifact in separate sandboxes against the
// control-plane artifact service, reached the way a container reaches the host:
// host.docker.internal on 0.0.0.0. The same shape as release.yml: one job builds a file and
// uploads it, a later job of the run downloads it and checks the checksum.
const enabled = process.env.TT_ARTIFACTS_E2E === "1";
const IMAGE = process.env.TT_ACT_IMAGE ?? "node:22-bookworm";
const UPLOAD = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"; // v4.6.2
const DOWNLOAD = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"; // v4.3.0
const tmp = mkdtempSync(join(tmpdir(), "tt-artifacts-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const WORKFLOW = (payload: string): string => `name: artifacts-e2e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p out && printf '%s' '${payload}' > out/app.bin && sha256sum out/app.bin | cut -d' ' -f1 > out/app.sha256
      - uses: ${UPLOAD}
        with:
          name: app
          path: out/
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: ${DOWNLOAD}
        with:
          name: app
          path: got/
      - run: |
          cd got && test "$(sha256sum app.bin | cut -d' ' -f1)" = "$(cat app.sha256)" && echo "checksum-ok=$(cat app.bin)"
`;

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

describe.skipIf(!enabled)("artifacts end to end (real act, real artifact actions, docker)", () => {
  const setup = (async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
    const port = await freePort();
    const svc = createArtifactService({
      db,
      store: new FsArtifactStore(join(tmp, "artifacts")),
      grants: new ArtifactGrants(),
      maxArtifactBytes: 64 * 1024 ** 2,
      baseUrl: `http://host.docker.internal:${port}`,
    });
    const server = startServer({ port, host: "0.0.0.0", db, artifacts: svc });
    const scope = { orgId: org.id, projectId: project.id };
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "artifacts e2e\n");
    return { db, svc, server, scope, repoTarball: await tarDirectory(repo) };
  })();

  async function newRun(klass: TrustClass, payload: string) {
    const { db, scope } = await setup;
    const run = await createRun(db, scope, {
      workflowPath: ".github/workflows/artifacts.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      trust: JSON.stringify({
        class: klass,
        reasons: [],
        facts: {},
        workflowHash: "h",
        decidedAt: 1,
      }),
    });
    return { run, yaml: WORKFLOW(payload) };
  }

  async function runJobAs(
    r: Awaited<ReturnType<typeof newRun>>,
    klass: TrustClass,
    jobId: "build" | "verify",
  ): Promise<{ state: string; log: string }> {
    const { db, svc, scope, repoTarball } = await setup;
    const planned = planJob(r.yaml, jobId, {
      workflowPath: ".github/workflows/artifacts.yml",
      readFile: () => undefined,
    });
    let plan = await resolveActions(planned, staticResolver({}));
    const job = (await createJob(db, scope, { runId: r.run.id, jobKey: jobId, name: jobId }))!;
    const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "docker" }))!;
    await db.run((h) =>
      h.orm
        .update(s.jobAttempts)
        .set({ trustClass: klass })
        .where(eq(s.jobAttempts.id, attempt.id)),
    );
    const grant = jobArtifactProvider(svc)({
      runId: r.run.id,
      attemptId: attempt.id,
      scope,
      klass,
      egress: "open",
      local: false,
    });
    if (!grant) throw new Error("no artifact grant");
    plan = rebuildArgv({
      ...plan,
      artifacts: { resultsUrl: grant.resultsUrl, token: grant.token },
    });
    const provider = new DockerProvider();
    const { id } = await provider.create({
      name: `tt-artifacts-e2e-${jobId}-${Date.now()}`,
      labels: { tt_artifacts_e2e: jobId },
      image: IMAGE,
      ttlSeconds: 1800,
      network: { egress: "open" },
    });
    try {
      const out: string[] = [];
      const result = await drain(
        runJob(provider, id, plan, { repoTarball }, { timeoutSeconds: 300 }),
        (e) => {
          if (e.kind === "log") out.push(new TextDecoder().decode(e.bytes));
        },
      );
      // The runner registers the credential with the job's redactor; act echoes its arguments.
      const registry = new SecretRegistry();
      registry.register(grant.token);
      const log = redactString(out.join(""), registry);
      expect(log).not.toContain(grant.token);
      return { state: result.state, log };
    } finally {
      grant.release();
      await provider.destroy(id);
    }
  }

  test("build uploads, a later job downloads it and the checksum holds; the record matches", async () => {
    const payload = `payload-${crypto.randomUUID()}`;
    const r = await newRun("protected", payload);
    expect((await runJobAs(r, "protected", "build")).state).toBe("success");
    const { db, scope } = await setup;
    const [row] = await listRunArtifacts(db, scope, r.run.id);
    expect(row).toMatchObject({ name: "app", klass: "protected", digestSource: "computed" });
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const verify = await runJobAs(r, "protected", "verify");
    expect(verify.state).toBe("success");
    expect(verify.log).toContain(`checksum-ok=${payload}`);
  }, 900_000);

  test("a release job cannot download what a lower class built in the same run", async () => {
    const r = await newRun("release", "x");
    expect((await runJobAs(r, "untrusted_pr", "build")).state).toBe("success");
    const verify = await runJobAs(r, "release", "verify");
    expect(verify.state).not.toBe("success");
  }, 900_000);

  afterAll(async () => {
    (await setup).server.stop(true);
  });
});
