import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "@longshore/act-runner";
import { DockerProvider } from "@longshore/provider-docker";
import { SecretRegistry, redactString } from "@longshore/redact";
import { CacheGrants } from "../src/cache/grants";
import { jobCacheProvider } from "../src/cache/job";
import { createCacheService } from "../src/cache/service";
import { FsCacheStore } from "../src/cache/store";
import { createOrg, createProject, createRun, openDatabase, type Run } from "../src/db";
import { startServer } from "../src/server";
import type { TrustClass } from "../src/trust";

// CI only (TT_CACHE_E2E=1): needs Docker, network for the pinned act download and the pinned
// actions/cache, and an image with bash, git, node and tar (node:22-bookworm). Real act runs
// real actions/cache in separate sandboxes against the control-plane cache service, reached the
// way a container reaches the host: host.docker.internal on 0.0.0.0.
//
// actions/cache v4.2.4 (pinned by commit) uses the v1 REST protocol unless
// ACTIONS_CACHE_SERVICE_V2 is set, which act does not set.
const enabled = process.env.TT_CACHE_E2E === "1";
const IMAGE = process.env.TT_ACT_IMAGE ?? "node:22-bookworm";
const CACHE_ACTION = "actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809";
const tmp = mkdtempSync(join(tmpdir(), "tt-cache-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const WORKFLOW = (key: string, payload: string): string => `name: cache-e2e
on: [push, pull_request]
jobs:
  save:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p cache-dir && echo "${payload}" > cache-dir/file.txt
      - uses: ${CACHE_ACTION.replace("cache@", "cache/save@")}
        with:
          path: cache-dir
          key: ${key}
  restore:
    runs-on: ubuntu-latest
    steps:
      - id: c
        uses: ${CACHE_ACTION.replace("cache@", "cache/restore@")}
        with:
          path: cache-dir
          key: ${key}
      - run: |
          if [ -f cache-dir/file.txt ]; then echo "restored-file=$(cat cache-dir/file.txt)"; else echo "restored-file=none"; fi
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

describe.skipIf(!enabled)("job cache end to end (real act, real actions/cache, docker)", () => {
  let attempt = 0;
  const setup = (async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
    // The URL a container uses must carry the port the server will listen on, so pick it first.
    const port = await freePort();
    const svc = createCacheService({
      db,
      store: new FsCacheStore(join(tmp, "blobs")),
      grants: new CacheGrants(),
      orgQuotaBytes: 512 * 1024 ** 2,
      maxEntryBytes: 128 * 1024 ** 2,
      // What a container uses to reach this process (the docker provider maps the name).
      baseUrl: `http://host.docker.internal:${port}`,
    });
    // Bound on all interfaces, as the docs say, so the container can reach it.
    const server = startServer({ port, host: "0.0.0.0", db, cache: svc });
    const scope = { orgId: org.id, projectId: project.id };
    const repo = join(tmp, "repo");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "cache e2e\n");
    const repoTarball = await tarDirectory(repo);
    return { db, svc, server, scope, repoTarball };
  })();

  async function runAs(
    klass: TrustClass,
    ref: { event: string; ref: string; prNumber: number | null },
    jobId: "save" | "restore",
    key: string,
    payload: string,
  ): Promise<string> {
    const { db, svc, scope, repoTarball } = await setup;
    const yaml = WORKFLOW(key, payload);
    const planned = planJob(yaml, jobId, {
      workflowPath: ".github/workflows/cache.yml",
      readFile: () => undefined,
    });
    let plan = await resolveActions(planned, staticResolver({}));
    const run = await createRun(db, scope, {
      workflowPath: ".github/workflows/cache.yml",
      event: ref.event,
      ref: ref.ref,
      sha: "a".repeat(40),
      ...(ref.prNumber === null ? {} : { prNumber: ref.prNumber }),
    });
    const cache = await jobCacheProvider(
      db,
      svc,
    )({
      run: run as Run,
      attemptId: `e2e-${++attempt}`,
      scope,
      klass,
      egress: "open",
    });
    if (!cache) throw new Error("no cache grant");
    plan = rebuildArgv({ ...plan, cacheUrl: cache.url });
    const provider = new DockerProvider();
    const { id } = await provider.create({
      name: `tt-cache-e2e-${jobId}-${attempt}-${Date.now()}`,
      labels: { tt_cache_e2e: jobId },
      image: IMAGE,
      ttlSeconds: 1800,
      network: { egress: "open" },
    });
    try {
      const events: string[] = [];
      const result = await drain(
        runJob(provider, id, plan, { repoTarball }, { timeoutSeconds: 300 }),
        (e) => {
          if (e.kind === "log") events.push(new TextDecoder().decode(e.bytes));
          if (e.kind === "act" && e.event.type === "step-end")
            console.log(`[${klass}/${jobId}] step ${e.event.name}: ${e.event.result}`);
        },
      );
      // What the job log holds is this stream after redaction (the runner registers the cache
      // credential with the job's redactor); act itself echoes its arguments.
      const registry = new SecretRegistry();
      registry.register(cache.secret);
      const log = redactString(events.join(""), registry);
      if (result.state !== "success") console.log(JSON.stringify(result), "\n", log);
      expect(result.state).toBe("success");
      expect(log).not.toContain(cache.secret);
      return log;
    } finally {
      cache.release();
      await provider.destroy(id);
    }
  }

  const push = { event: "push", ref: "refs/heads/main", prNumber: null };
  const pr = (n: number) => ({ event: "pull_request", ref: `refs/pull/${n}/merge`, prNumber: n });

  test("a job saves, a second job in another sandbox restores the same key and sees the file", async () => {
    const payload = `payload-${crypto.randomUUID()}`;
    await runAs("protected", push, "save", "e2e-basic", payload);
    const log = await runAs("protected", push, "restore", "e2e-basic", payload);
    expect(log).toContain(`restored-file=${payload}`);
    // And a third job with another key finds nothing.
    const miss = await runAs("protected", push, "restore", "e2e-other-key", payload);
    expect(miss).toContain("restored-file=none");
  }, 900_000);

  test("a trusted PR cannot restore a key written only by another PR, and an untrusted PR cannot read protected caches", async () => {
    const payload = `payload-${crypto.randomUUID()}`;
    // PR 1 saves and can restore its own.
    await runAs("trusted_pr", pr(1), "save", "e2e-pr-only", payload);
    expect(await runAs("trusted_pr", pr(1), "restore", "e2e-pr-only", payload)).toContain(
      `restored-file=${payload}`,
    );
    // PR 2 asks for the same key and gets nothing.
    expect(await runAs("trusted_pr", pr(2), "restore", "e2e-pr-only", payload)).toContain(
      "restored-file=none",
    );
    // A trusted PR reads the protected (default branch) cache; an untrusted one does not.
    await runAs("protected", push, "save", "e2e-protected", payload);
    expect(await runAs("trusted_pr", pr(3), "restore", "e2e-protected", payload)).toContain(
      `restored-file=${payload}`,
    );
    expect(await runAs("untrusted_pr", pr(4), "restore", "e2e-protected", payload)).toContain(
      "restored-file=none",
    );
  }, 1_800_000);

  afterAll(async () => {
    (await setup).server.stop(true);
  });
});
