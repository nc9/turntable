// The release golden path, end to end and in process: a tag push becomes a release-class run, its
// artifacts are recorded, a release is requested, the release lane re-checks the tag and the
// bytes, the approval quorum is verified from an enrolled key's signature, the lane signs, and
// the release is published to a fake npm registry and a fake GitHub. `turntable verify` then
// passes on the downloaded asset and fails on a tampered one. One negative per gate follows, and
// each proves that nothing was signed and nothing reached either fake.
//
// Fakes: the GitHub API (git refs, releases, uploads) and npm are one SafeFetch; the sandbox
// provider is not involved (the run is created the way the poller creates it, and its job is
// recorded as finished). It is slower than a unit test, so it has its own CI job.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tarDirectory } from "@turntable/act-runner";
import type { SafeFetch } from "@turntable/net";
import { LocalSigner, sha256Hex } from "@turntable/signer";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import { RELEASE_STATEMENT_TYPE, releaseStatementSchema } from "../src/approvals/statement";
import {
  clearFreeze,
  createAttempt,
  createOrg,
  createPolledRun,
  createProject,
  getProjectBySlug,
  getReleaseRequest,
  insertApprover,
  listAudit,
  listJobs,
  listRuns,
  openDatabase,
  setGithubApp,
  recordArtifact,
  setEnvPolicy,
  setFreeze,
  setProjectSigning,
  schema,
  setRunStatus,
  type Db,
} from "../src/db";
import { getJob, getRun, setApproveRunMinRole, transitionJob } from "../src/db/repos";
import { createWebhookHandler } from "../src/github/webhook";
import { SECRET_WEBHOOK } from "../src/github/app-auth";
import { dispatch, registry } from "../src/ops";
import { Poller, pollConfigSchema } from "../src/poll";
import { SecretStore } from "../src/secrets/store";
import { makeGithub } from "./github-stub";
import { AttestationStore } from "../src/release/attest";
import type { LaneConfigClient } from "../src/release/channel-client";
import type { FileKeyVault } from "../src/release/key-vault";
import { dirArtifacts } from "../src/release/artifacts";
import { githubForge } from "../src/release/forge";
import { fileKeyVault } from "../src/release/key-vault";
import { ReleaseLane } from "../src/release/lane";
import { keysDir, signingWiring } from "../src/release/serve";
import { SecretVault } from "../src/secrets/vault";
import { builtinKeyRef } from "../src/signing";
import { decideRun } from "../src/trust";
import { verifyCommand } from "../src/verify/cli";
import { mintToken } from "./ops-helpers";
import { opsHarness } from "./release-config-helpers";

const SHA = "a".repeat(40);
const TAG = "v1.0.0";
const WF_HASH = "ab".repeat(32);
const NPM_TOKEN = ["npm", "publish", "token", "9c2e17"].join("_");
const GH_TOKEN = ["gh", "lane", "write", "token", "4b6d"].join("_");
const BUILDER = "https://ci.example.test/turntable";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const tmp = mkdtempSync(join(tmpdir(), "ls-golden-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---- the fake internet: GitHub and npm in one SafeFetch ----

interface Internet {
  /** tag -> commit sha, as GitHub's git refs API reports it */
  tags: Map<string, string>;
  release:
    | { id: number; draft: boolean; assets: Map<number, { name: string; bytes: Uint8Array }> }
    | undefined;
  nextId: number;
  npm: Map<string, string>; // version -> integrity
  /** Every request that would change something outside: uploads, releases, publishes. */
  writes: string[];
  fetch: SafeFetch;
}

function internet(): Internet {
  const net: Internet = {
    tags: new Map([[TAG, SHA]]),
    release: undefined,
    nextId: 100,
    npm: new Map(),
    writes: [],
    fetch: async (input, init) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body;
      const text = typeof body === "string" ? body : "";
      if (method !== "GET" && method !== "HEAD")
        net.writes.push(`${method} ${u.hostname}${u.pathname}`);
      if (u.hostname === "registry.test") {
        if (method === "GET") {
          const versions = Object.fromEntries(
            [...net.npm].map(([v, i]) => [v, { dist: { integrity: i } }]),
          );
          return net.npm.size === 0
            ? Response.json({}, { status: 404 })
            : Response.json({ versions });
        }
        const doc = JSON.parse(text) as {
          versions: Record<string, { dist: { integrity: string } }>;
        };
        for (const [v, m] of Object.entries(doc.versions)) net.npm.set(v, m.dist.integrity);
        return Response.json({}, { status: 201 });
      }
      if (u.hostname === "api.gh.test" || u.hostname === "up.gh.test") {
        const ref = /^\/repos\/acme\/web\/git\/ref\/tags\/(.+)$/.exec(u.pathname);
        if (ref) {
          const sha = net.tags.get(decodeURIComponent(ref[1]!));
          return sha
            ? Response.json({ object: { type: "commit", sha } })
            : Response.json({}, { status: 404 });
        }
        const m =
          /^\/repos\/acme\/web\/releases(?:\/tags\/([^/]+)|\/assets\/(\d+)|\/(\d+)\/assets|\/(\d+))?$/.exec(
            u.pathname,
          );
        if (!m) return Response.json({}, { status: 404 });
        const [, tagName, assetId, uploadFor, relId] = m;
        const view = () => ({
          id: net.release!.id,
          draft: net.release!.draft,
          assets: [...net.release!.assets].map(([id, x]) => ({ id, name: x.name })),
        });
        if (method === "GET" && tagName)
          return net.release ? Response.json(view()) : Response.json({}, { status: 404 });
        if (method === "POST" && !tagName && !assetId && !uploadFor && !relId) {
          net.release = { id: ++net.nextId, draft: true, assets: new Map() };
          return Response.json(view(), { status: 201 });
        }
        if (method === "POST" && uploadFor) {
          net.release!.assets.set(++net.nextId, {
            name: u.searchParams.get("name")!,
            bytes: body as Uint8Array,
          });
          return Response.json({}, { status: 201 });
        }
        if (method === "GET" && assetId)
          return new Response(net.release!.assets.get(Number(assetId))!.bytes, { status: 200 });
        if (method === "PATCH" && relId) {
          net.release!.draft = (JSON.parse(text) as { draft: boolean }).draft;
          return Response.json(view());
        }
      }
      return Response.json({}, { status: 404 });
    },
  };
  return net;
}

// ---- the world ----

interface World {
  db: Db;
  orgId: string;
  scope: { orgId: string; projectId: string };
  runId: string;
  net: Internet;
  lane: ReleaseLane;
  attest: AttestationStore;
  releaseTok: string;
  dir: string;
  publicKeyPem: string;
  /** The lane's sealed signing keys (the vault `release_public_key` reads through the channel). */
  keys: FileKeyVault;
  binary: Uint8Array;
  tarball: Uint8Array;
  request(artifacts?: string[]): Promise<string>;
  /**
   * Approve the run again, under the lane's configuration as it now is. The release job waits for
   * approval once, so a re-approval reruns only that job through the `rerun` op (it waits again),
   * then one more approver signs a fresh statement. No direct DB writes.
   */
  reapprove(): Promise<void>;
  state(id: string): Promise<{ status: string; reason: string | null; result: any }>;
  signAudits(): Promise<string[]>;
  /** Set when the run came from a signed tag push webhook through the poller. */
  ingested?: Ingested;
  stop(): void;
}

async function npmTarball(): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(d, "package"));
  writeFileSync(
    join(d, "package", "package.json"),
    JSON.stringify({ name: "@acme/web", version: "1.0.0" }),
  );
  return tarDirectory(d, ["package"]);
}

// ---- ingest: a signed tag push webhook, the poller's nudge, and the tag's run ----

const TAG_WORKFLOW = `name: Release
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  release:
    needs: build
    environment: release
    runs-on: ubuntu-latest
    steps:
      - run: echo release
`;

export interface Ingested {
  runId: string;
  buildJobId: string;
  releaseJobId: string;
  trust: { class: string; workflowHash: string; facts: Record<string, unknown>; reasons: string[] };
  webhookStatus: number;
  gh: ReturnType<typeof makeGithub>;
  stop(): void;
}

const until = async <T>(what: string, f: () => Promise<T | undefined>): Promise<T> => {
  for (let i = 0; i < 200; i += 1) {
    const v = await f();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * Starts a poller for acme/web (the tag patterns opted in), lets it take the default branch, then
 * creates the tag at GitHub and sends the signed push webhook for it. The webhook handler is the
 * real one: its only effect is to nudge the poller, which then reads the facts from GitHub itself
 * and creates the tag's run. `protect` says whether a ruleset restricts creating the tag.
 */
async function ingestTag(
  db: Db,
  orgId: string,
  o: { protect: boolean; tagCommit?: string; lightweight?: boolean },
): Promise<Ingested> {
  const gh = makeGithub();
  gh.state.files.set("*", TAG_WORKFLOW);
  gh.state.history = [{ sha: SHA, parents: [] }];
  gh.state.rulesets = o.protect
    ? [
        {
          id: 1,
          include: ["refs/tags/v*"],
          bypass: [{ actor_type: "RepositoryRole", actor_id: 5 }],
        },
      ]
    : [];
  const clock = { t: 1_800_000_000_000 };
  const poller = new Poller({
    db,
    config: pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        {
          repo: "acme/web",
          org: "acme",
          project: "web",
          workflow: ".github/workflows/ci.yml",
          defaultBranch: "main",
          tagRefs: ["refs/tags/v*"],
          intervalSeconds: 3600,
          maxRunsPerHour: 1000,
          maxWaitingRuns: 500,
        },
      ],
    }),
    fetch: gh.fetch,
    now: () => clock.t,
  });
  // The real webhook handler, with the App's webhook secret in the real secret store.
  const masterKey = randomBytes(32);
  const store = new SecretStore(db, masterKey);
  await setGithubApp(
    db,
    { orgId },
    {
      appId: "42",
      slug: "turntable-test",
      name: "Turntable",
      ownerLogin: "acme",
      htmlUrl: "https://github.com/apps/x",
      clientId: "Iv1.abc",
    },
  );
  const secret = ["whsec", "golden", "7731"].join("_");
  await store.set(orgId, SECRET_WEBHOOK, secret);
  const handler = createWebhookHandler({
    db,
    store,
    facts: { getInstallation: async () => undefined, listInstallationRepos: async () => [] },
    onRepoEvent: (repo) => void poller.nudge(repo),
    log: () => {},
  });

  poller.start();
  const scope = await (async () => {
    const proj = await getProjectBySlug(db, { orgId }, "web");
    return { orgId, projectId: proj!.id };
  })();
  // The first poll takes the default branch: no tag run yet.
  await until("the first poll", async () =>
    (await listRuns(db, scope)).some((r) => r.ref === "refs/heads/main") ? true : undefined,
  );
  expect((await listRuns(db, scope)).some((r) => r.ref.startsWith("refs/tags/"))).toBe(false);

  // The tag is created at GitHub, and GitHub tells us with a signed push webhook. The payload
  // lies about the commit and the pusher: none of it is read.
  // An annotated tag by default, so the run has a creator (its tagger) the approvers differ from.
  gh.state.tags.set(
    TAG,
    o.lightweight
      ? { sha: o.tagCommit ?? SHA }
      : { sha: o.tagCommit ?? SHA, annotatedAs: "9".repeat(40), tagger: "Release Bot" },
  );
  clock.t += 60_000;
  const body = JSON.stringify({
    ref: `refs/tags/${TAG}`,
    after: "f".repeat(40),
    pusher: { name: "mallory" },
    repository: { full_name: "acme/web" },
  });
  const res = await handler.handle(
    new Request("http://x/api/v1/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "x-github-event": "push",
        "x-github-delivery": "11111111-2222-3333-4444-555555555555",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }),
    "203.0.113.5",
  );
  const webhookStatus = res!.status;
  const run = await until("the tag's run", async () =>
    (await listRuns(db, scope)).find((r) => r.ref === `refs/tags/${TAG}`),
  ).catch(() => undefined);
  if (!run) {
    poller.stop();
    throw new Error("the tag was not ingested");
  }
  // The run row is visible before everything the poller writes for it: its jobs, and the
  // poll_tag_run audit row, which is appended after the run is created. Wait for both, so no
  // assertion reads them before they exist.
  const jobs = await until("the tag run's jobs", async () => {
    const js = await listJobs(db, scope, run.id);
    return js.some((j) => j.jobKey === "build") && js.some((j) => j.jobKey === "release")
      ? js
      : undefined;
  }).catch(() => undefined);
  const audited = await until("the poll_tag_run audit row", async () =>
    (await listAudit(db, scope)).some((x) => x.op === "poll_tag_run") ? true : undefined,
  ).catch(() => undefined);
  if (!jobs || !audited) {
    poller.stop();
    throw new Error("the tag run was not fully written");
  }
  return {
    runId: run.id,
    buildJobId: jobs.find((j) => j.jobKey === "build")!.id,
    releaseJobId: jobs.find((j) => j.jobKey === "release")!.id,
    trust: JSON.parse(run.trust!),
    webhookStatus,
    gh,
    stop: () => poller.stop(),
  };
}

async function world(
  o: {
    fork?: boolean;
    approve?: boolean;
    tamperBytes?: boolean;
    /** The attempt that wrote the tarball ran as this lower class. */
    lowerTarball?: string;
    /** Create the run from a signed tag push webhook through the poller, not directly. */
    ingest?: {
      protect: boolean;
      lightweight?: boolean;
      allowAuthorApproval?: boolean;
      /** Distinct approvers the environment needs (default 1, the solo setup). */
      quorum?: number;
      /**
       * Distinct approvers who sign. Default: what the run needs: the quorum, plus one when the
       * author is unknown and author approval is not allowed.
       */
      approvers?: number;
    };
  } = {},
): Promise<World> {
  const db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
  const scope = { orgId: org.id, projectId: project.id };
  const dir = mkdtempSync(join(tmp, "w-"));
  const net = internet();
  const binary = enc("the linux binary, built from the tag");
  const tarball = await npmTarball();

  // 1. The project's release policy, the approval quorum (one enrolled key, a solo policy) and
  //    the tokens an operator would hold.
  await setProjectSigning(db, scope, { signingKey: "builtin:release", environment: "release" });
  await setEnvPolicy(db, org.id, {
    environment: "release",
    required: o.ingest?.quorum ?? 1,
    // A tag run has no known author, so the "author cannot approve" rule cannot be met: a
    // release from an ingested tag needs the environment's policy to allow author approval.
    allowAuthorApproval: o.ingest ? (o.ingest.allowAuthorApproval ?? true) : false,
    by: "test",
    now: Date.now(),
  });
  const releaseTok = (
    await mintToken(db, { orgId: org.id }, "release_operator", { kind: "person" })
  ).secret;
  const operatorTok = (await mintToken(db, { orgId: org.id }, "operator", { kind: "person" }))
    .secret;
  // The lane's own file, configured BEFORE anyone approves: a release approval binds the lane's
  // configuration version (the pin, targets and secrets the approver saw), which the server reads
  // from the lane when it issues the challenge. Here the lane's version is read straight from its
  // file, through the same call shape the config channel answers.
  const attest = new AttestationStore(join(dir, "attested.db"));
  attest.pinRepo(org.id, project.id, "acme/web", Date.now());
  attest.setPublishTarget(
    org.id,
    project.id,
    "npm",
    {
      kind: "npm",
      mode: "strict",
      package: "@acme/web",
      artifact: "web-1.0.0.tgz",
      tag: "latest",
      access: "public",
      secret: "NPM_TOKEN",
    },
    Date.now(),
  );
  attest.setPublishTarget(
    org.id,
    project.id,
    "release",
    {
      kind: "github-release",
      mode: "strict",
      assets: ["cli-linux"],
      provenanceAsset: "provenance.intoto.json",
    },
    Date.now(),
  );
  const laneVersion: LaneConfigClient = {
    async call() {
      return { ok: true, result: { config_version: attest.configVersion() } };
    },
  };
  const env = { registry, db, releaseConfig: laneVersion };
  const call = (tok: string, op: string, input: unknown) =>
    dispatch(env, { kind: "bearer", token: tok }, op, input);

  // 2. A tag push becomes a run. Directly: classified by the same decision the poller makes (a
  //    fork's pull request that happens to name a tag ref is the untrusted case). Or through the
  //    real path: a signed push webhook wakes the poller, which ingests the tag.
  let runId: string;
  let jobId: string;
  let ingested: Ingested | undefined;
  if (o.ingest) {
    ingested = await ingestTag(db, org.id, o.ingest);
    runId = ingested.runId;
    jobId = ingested.releaseJobId;
    // A tag no ruleset protects was created held: a release operator approves it first.
    if (!o.ingest.protect) {
      const r = await call(releaseTok, "approve_run", {
        run_id: runId,
        head_sha: SHA,
        workflow_hash: ingested.trust.workflowHash,
      });
      if (!r.ok) throw new Error(`approve_run: ${r.error.message}`);
    }
  } else {
    const trust = o.fork
      ? decideRun({
          event: "pull_request",
          ref: `refs/tags/${TAG}`,
          sameRepo: false,
          actor: "stranger",
          permission: "none",
          workflowHash: WF_HASH,
          now: Date.now(),
        })
      : decideRun({
          event: "push",
          ref: `refs/tags/${TAG}`,
          sameRepo: true,
          actor: "pusher",
          permission: "write",
          workflowHash: WF_HASH,
          now: Date.now(),
        });
    const planned = {
      key: "release",
      id: "release",
      name: "release",
      needs: [],
      needsIds: [],
      environment: "release",
      continueOnError: false,
      outputs: {},
      failFast: true,
    };
    const created = await createPolledRun(db, scope, {
      repo: "acme/web",
      provider: "test",
      run: {
        workflowPath: ".github/workflows/release.yml",
        event: o.fork ? "pull_request" : "push",
        ref: `refs/tags/${TAG}`,
        sha: SHA,
        actor: o.fork ? "stranger" : "pusher",
        trust: JSON.stringify(trust),
      },
      jobs: [{ key: "release", name: "release", needs: [], planned }],
      ...(o.fork ? { hold: true } : {}),
    });
    runId = created!.run.id;
    jobId = (await db.orm.query.jobs.findFirst({ where: (j, { eq }) => eq(j.runId, runId) }))!.id;
  }

  // The build recorded its artifacts first: a release approval (#424) names the digest of exactly
  // these, so they must be known before anyone approves.
  const attempt = (await createAttempt(db, scope, { jobId, provider: "test" }))!;
  const files: Record<string, Uint8Array> = { "cli-linux": binary, "web-1.0.0.tgz": tarball };
  // What an attempt writes is only as trusted as the class it ran as (#39); the lease records it.
  const asClass = async (attemptId: string, klass: string): Promise<void> => {
    await db.run(async (h) => {
      await h.orm
        .update(schema.jobAttempts)
        .set({ trustClass: klass })
        .where(eq(schema.jobAttempts.id, attemptId));
    });
  };
  await asClass(attempt.id, "release");
  const lower = o.lowerTarball
    ? (await createAttempt(db, scope, { jobId, provider: "test" }))!
    : undefined;
  if (lower && o.lowerTarball) await asClass(lower.id, o.lowerTarball);
  for (const [name, bytes] of Object.entries(files)) {
    await recordArtifact(db, scope, {
      runId,
      attemptId: lower && name === "web-1.0.0.tgz" ? lower.id : attempt.id,
      name,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    });
  }
  let reapprovals = 0;
  /** One approver (a new key, a new person) signs one release statement for the run. */
  const approveOnce = async (n: number): Promise<void> => {
    const key = generateEd25519();
    const approver = await insertApprover(
      db,
      org.id,
      {
        person: `rel${n}`,
        forgeLogin: `releaser${n}`,
        kind: "ed25519",
        publicKey: key.publicSpki,
        alg: "EdDSA",
        createdBy: "test",
      },
      Date.now(),
    );
    const c = await call(operatorTok, "release_approval_challenge", {
      run_id: runId,
      approver: approver.id,
      project: "web",
    });
    if (!c.ok) {
      ingested?.stop();
      throw new Error(`challenge: ${c.error.message}`);
    }
    const ch = c.output as { statement: unknown; canonical: string };
    const r = await dispatch(env, { kind: "signed" }, "approve_release", {
      statement: ch.statement,
      signature: { kind: "ed25519", signature: signEd25519(key.privatePem, ch.canonical) },
    });
    if (!r.ok) {
      ingested?.stop();
      throw new Error(`approve: ${r.error.message}`);
    }
  };
  if (o.approve !== false && !o.fork) {
    // One approver per required identity: distinct forge logins, none of them the (unknown) author.
    const quorum = o.ingest?.quorum ?? 1;
    const needed = quorum + (o.ingest && o.ingest.allowAuthorApproval === false ? 1 : 0);
    for (let n = 0; n < (o.ingest?.approvers ?? needed); n += 1) await approveOnce(n);
  }

  // 3. The job finished; the bytes sit where the lane reads them.
  await setRunStatus(db, scope, runId, "running");
  await setRunStatus(db, scope, runId, "success");
  mkdirSync(join(dir, "artifacts", runId), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const onDisk = o.tamperBytes && name === "cli-linux" ? enc("something else entirely") : bytes;
    writeFileSync(join(dir, "artifacts", runId, name), onDisk);
  }

  // 4. The release lane: its own key, its own file, the real signing service and approval
  //    verifier, the real vault for the npm token, strict publish targets.
  const masterKey = randomBytes(32);
  const keys = fileKeyVault(keysDir(dir), masterKey);
  const local = new LocalSigner(keys);
  const ref = builtinKeyRef(org.id, "release");
  await local.ensureKey(ref);
  const publicKeyPem = (await local.publicKey(ref)).publicKeyPem;
  const w = await signingWiring({ db, masterKey, dataDir: dir, builderId: BUILDER });
  await new SecretVault({ db, masterKey }).set(org.id, "test", { name: "NPM_TOKEN" }, NPM_TOKEN, {
    destinations: ["registry.test"],
    trustClasses: ["release"],
  });
  const vault = new SecretVault({ db, masterKey, lane: "release" });
  const lane = new ReleaseLane({
    db,
    forge: githubForge({
      token: "lane-forge-token",
      fetch: net.fetch,
      apiBase: "https://api.gh.test",
    }),
    bytes: dirArtifacts(join(dir, "artifacts")),
    records: w.records,
    attest,
    signer: w.signer,
    publish: {
      credentials: {
        async secret(sc, name, destination, tag, requestId) {
          const r = await vault.usePublishCredential({ ...sc, name, destination, tag, requestId });
          return r.ok ? r.value : undefined;
        },
        async githubToken() {
          return GH_TOKEN;
        },
      },
      fetch: net.fetch,
      npmRegistry: "https://registry.test",
      githubApi: "https://api.gh.test",
      githubUploads: "https://up.gh.test",
    },
    owner: "golden-lane",
  });

  return {
    db,
    orgId: org.id,
    scope,
    runId,
    net,
    lane,
    attest,
    releaseTok,
    dir,
    publicKeyPem,
    keys,
    binary,
    tarball,
    async reapprove() {
      // The real path, no direct DB writes: the release job finished (the way a scheduler ends
      // it), the operator reruns ONLY that job through the `rerun` op, the fresh attempt waits for
      // approval, one more approver signs a statement under the lane's current version, and the
      // job runs and succeeds again.
      const finish = async (): Promise<void> => {
        const j = await getJob(db, scope, jobId);
        if (j?.state === "queued") await transitionJob(db, scope, jobId, "running");
        if ((await getJob(db, scope, jobId))?.state === "running") {
          await transitionJob(db, scope, jobId, "success", { exitCode: 0 });
        }
        const run = await getRun(db, scope, runId);
        if (run?.status === "queued") await setRunStatus(db, scope, runId, "running");
        if ((await getRun(db, scope, runId))?.status === "running") {
          await setRunStatus(db, scope, runId, "success");
        }
      };
      await finish();
      const rr = await call(operatorTok, "rerun", {
        run_id: runId,
        jobs: ["release"],
        reason: "lane config changed after approval",
      });
      if (!rr.ok) throw new Error(`rerun: ${rr.error.code} ${rr.error.message}`);
      const out = rr.output as { reruns: { job_key: string; state: string }[] };
      if (out.reruns.length !== 1 || out.reruns[0]!.state !== "awaiting_approval") {
        throw new Error(`rerun did not wait for approval: ${JSON.stringify(out.reruns)}`);
      }
      await approveOnce(100 + reapprovals++);
      await finish();
    },
    async request(artifacts = ["cli-linux", "web-1.0.0.tgz"]) {
      const r = await call(releaseTok, "request_release", {
        run_id: runId,
        tag: TAG,
        artifacts,
        project: "web",
      });
      if (!r.ok) throw new Error(`request_release: ${r.error.code} ${r.error.message}`);
      return (r.output as { id: string }).id;
    },
    async state(id) {
      const row = (await getReleaseRequest(db, scope, id))!;
      return {
        status: row.status,
        reason: row.reason,
        result: row.result ? JSON.parse(row.result) : null,
      };
    },
    async signAudits() {
      return (await listAudit(db, scope))
        .filter((x) => x.op === "sign_release")
        .map((x) => x.outcome);
    },
    ...(ingested ? { ingested } : {}),
    stop() {
      ingested?.stop();
    },
  };
}

/** A lane config client answering the version from the lane's own file. */
const laneVersionOf = (attest: AttestationStore): LaneConfigClient => ({
  async call() {
    return { ok: true, result: { config_version: attest.configVersion() } };
  },
});

/** A fresh ed25519 approver of the world's org (a challenge is issued for one). */
let approverSeq = 0;
async function anApprover(world: World): Promise<{ id: string }> {
  const key = generateEd25519();
  approverSeq += 1;
  return insertApprover(
    world.db,
    world.orgId,
    {
      person: `extra${approverSeq}`,
      forgeLogin: `extra${approverSeq}`,
      kind: "ed25519",
      publicKey: key.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    Date.now(),
  );
}

let w: World;
afterEach(() => {
  w?.stop();
  w?.attest.close();
});

/** Runs `turntable verify` and returns its exit code with what it printed. */
async function verify(
  artifact: string,
  provenance: string,
  pubkey: string,
): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (m: string) => void out.push(String(m));
  console.error = (m: string) => void out.push(String(m));
  try {
    const code = await verifyCommand([
      artifact,
      "--provenance",
      provenance,
      "--pubkey",
      pubkey,
      "--name",
      "cli-linux",
    ]);
    return { code, out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** Request, sign, publish, download and verify: the release flow, whatever created the run. */
async function releaseAndVerify(): Promise<void> {
  const id = await w.request();
  expect(await w.lane.processNext()).toBe(true);
  const done = await w.state(id);
  expect(done).toMatchObject({ status: "signed" });
  expect(done.result.keyid).toBeTruthy();

  // strict publish: npm holds the verified tarball's integrity; GitHub holds a published
  // release with the binary and the lane's provenance
  expect(done.result.published).toMatchObject([
    { target: "npm", state: "published" },
    { target: "release", state: "published" },
  ]);
  expect(w.net.npm.get("1.0.0")).toBe(
    `sha512-${createHash("sha512").update(w.tarball).digest("base64")}`,
  );
  expect(w.net.release!.draft).toBe(false);
  const held = new Map([...w.net.release!.assets.values()].map((x) => [x.name, x.bytes]));
  expect([...held.keys()].sort()).toEqual(["cli-linux", "provenance.intoto.json"]);

  // the downloaded asset verifies against the downloaded provenance and the lane's public key
  const d = mkdtempSync(join(tmp, "dl-"));
  writeFileSync(join(d, "cli-linux"), held.get("cli-linux")!);
  writeFileSync(join(d, "provenance.intoto.json"), held.get("provenance.intoto.json")!);
  writeFileSync(join(d, "release.pub"), w.publicKeyPem);
  const good = await verify(
    join(d, "cli-linux"),
    join(d, "provenance.intoto.json"),
    join(d, "release.pub"),
  );
  expect(good.code).toBe(0);
  expect(good.out).toContain("cli-linux");

  // a tampered download does not
  const bad = Buffer.from(held.get("cli-linux")!);
  bad[0] = bad[0]! ^ 0xff;
  writeFileSync(join(d, "tampered"), bad);
  const no = await verify(
    join(d, "tampered"),
    join(d, "provenance.intoto.json"),
    join(d, "release.pub"),
  );
  expect(no.code).not.toBe(0);
  expect(no.out).toContain("NOT VERIFIED");

  // the audit trail has the request, the signature and both publishes, and no credential
  const audit = JSON.stringify(await listAudit(w.db, w.scope));
  expect(audit).toContain("publish:npm:published");
  expect(audit).toContain("publish:release:published");
  expect(audit).not.toContain(NPM_TOKEN);
  expect(audit).not.toContain(GH_TOKEN);
  expect(readFileSync(join(d, "provenance.intoto.json"), "utf8")).not.toContain(NPM_TOKEN);
}

describe("the golden path", () => {
  test("tag push to a verified, published, signed release", async () => {
    w = await world();
    // the run is a release-class run, held for nobody, with its job released by the quorum
    const run = (await w.db.orm.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, w.runId) }))!;
    expect(JSON.parse(run.trust!).class).toBe("release");
    await releaseAndVerify();
  });
});

describe("the same path, from a signed tag push webhook through the poller", () => {
  test("a tag protected by a ruleset: the webhook nudges the poller, the run is release and starts, and the release flow completes", async () => {
    w = await world({ ingest: { protect: true } });
    const ing = w.ingested!;
    expect(ing.webhookStatus).toBe(202);
    // ingested from GitHub's facts, not the webhook's payload (which named another commit)
    const run = (await w.db.orm.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, w.runId) }))!;
    expect(run).toMatchObject({
      event: "push",
      ref: `refs/tags/${TAG}`,
      sha: SHA,
      repo: "acme/web",
    });
    // no actor: the tagger is free text, kept only as a display label in the facts
    expect(run.actor).toBeNull();
    expect(ing.trust.facts).toMatchObject({ taggerLabel: "Release Bot" });
    expect(ing.trust.class).toBe("release");
    expect(ing.trust.facts).toMatchObject({ tagProtection: "ruleset" });
    // not held for the tag itself: only the environment's quorum gates the release job
    const jobs = await listJobs(w.db, w.scope, w.runId);
    expect(jobs.find((j) => j.jobKey === "build")!.approvalKind).toBeNull();
    const audit = (await listAudit(w.db, w.scope)).find((x) => x.op === "poll_tag_run")!;
    expect(audit).toMatchObject({ outcome: "release" });
    await releaseAndVerify();
  }, 30_000);

  test("a tag no ruleset protects is created held; only a release operator's approval lets it run, then the release flow completes", async () => {
    // First, the held state on its own: nothing runs until approval.
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
    const scope = { orgId: org.id, projectId: project.id };
    const ing = await ingestTag(db, org.id, { protect: false });
    try {
      expect(ing.webhookStatus).toBe(202);
      expect(ing.trust.class).toBe("release");
      expect(ing.trust.facts).toMatchObject({ tagProtection: "none" });
      expect(ing.trust.reasons.join(" ")).toContain("held for approval by a release operator");
      const build = (await listJobs(db, scope, ing.runId)).find((j) => j.jobKey === "build")!;
      expect(build).toMatchObject({ state: "awaiting_approval", approvalKind: "untrusted_author" });
      expect((await listAudit(db, scope)).find((x) => x.op === "poll_tag_run")).toMatchObject({
        outcome: "held",
      });
      // an operator cannot release it, even when the org lowered approve_run to operator
      await setApproveRunMinRole(db, org.id, "operator");
      const op = (await mintToken(db, { orgId: org.id }, "operator", { kind: "person" })).secret;
      const refused = await dispatch(
        { registry, db },
        { kind: "bearer", token: op },
        "approve_run",
        {
          run_id: ing.runId,
          head_sha: SHA,
          workflow_hash: ing.trust.workflowHash,
        },
      );
      expect(!refused.ok && refused.error.code).toBe("forbidden");
      expect((await listJobs(db, scope, ing.runId)).find((j) => j.jobKey === "build")!.state).toBe(
        "awaiting_approval",
      );
    } finally {
      ing.stop();
    }

    // Then the whole flow: a release operator approves, and the release goes through.
    w = await world({ ingest: { protect: false } });
    expect(w.ingested!.trust.facts).toMatchObject({ tagProtection: "none" });
    const jobs = await listJobs(w.db, w.scope, w.runId);
    expect(jobs.find((j) => j.jobKey === "build")!.state).toBe("queued");
    await releaseAndVerify();
  }, 30_000);

  test.each([
    ["an annotated tag", false],
    ["a lightweight tag", true],
  ])(
    "%s: with a quorum of two and an unknown author, three distinct approvers release it",
    async (_kind, lightweight) => {
      w = await world({
        ingest: { protect: true, lightweight, allowAuthorApproval: false, quorum: 2 },
      });
      expect(w.ingested!.trust.facts).toMatchObject({ tagProtection: "ruleset" });
      const run = (await w.db.orm.query.runs.findFirst({
        where: (r, { eq }) => eq(r.id, w.runId),
      }))!;
      expect(run.actor).toBeNull();
      // the audit says why three were needed
      const note = (await listAudit(w.db, w.scope)).find(
        (x) => x.op === "approval_author_unknown",
      )!;
      expect(JSON.parse(note.input).note).toBe(
        "author unknown; required 3 distinct approvers (2+1)",
      );
      await releaseAndVerify();
    },
    30_000,
  );

  test("with a quorum of two, two approvers are not enough for a tag run: the signer refuses", async () => {
    w = await world({
      ingest: { protect: true, allowAuthorApproval: false, quorum: 2, approvers: 2 },
    });
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "refused" });
    expect(w.net.writes).toEqual([]);
    expect(w.net.npm.size).toBe(0);
  });

  test("with a quorum of one and no allowAuthorApproval, one approver is not enough but two are", async () => {
    for (const lightweight of [false, true]) {
      w?.stop();
      w?.attest.close();
      w = await world({
        ingest: {
          protect: true,
          lightweight,
          allowAuthorApproval: false,
          quorum: 1,
          approvers: 1,
        },
      });
      const id = await w.request();
      await w.lane.processNext();
      expect(await w.state(id)).toMatchObject({ status: "refused" });
      w.stop();
      w.attest.close();
      w = await world({
        ingest: { protect: true, lightweight, allowAuthorApproval: false, quorum: 1 },
      });
      await releaseAndVerify();
    }
  }, 30_000);

  test("the solo policy (a quorum of one, author approval allowed) passes, annotated or not", async () => {
    for (const lightweight of [false, true]) {
      w?.stop();
      w?.attest.close();
      w = await world({ ingest: { protect: true, lightweight, quorum: 1 } });
      await releaseAndVerify();
    }
  });

  test("a forged webhook signature ingests nothing", async () => {
    // The handler is the real one: a bad signature is refused before anything is read.
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
    const store = new SecretStore(db, randomBytes(32));
    await setGithubApp(
      db,
      { orgId: org.id },
      {
        appId: "42",
        slug: "turntable-test",
        name: "Turntable",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/x",
        clientId: "Iv1.abc",
      },
    );
    await store.set(org.id, SECRET_WEBHOOK, ["whsec", "real", "1"].join("_"));
    const woken: string[] = [];
    const handler = createWebhookHandler({
      db,
      store,
      facts: { getInstallation: async () => undefined, listInstallationRepos: async () => [] },
      onRepoEvent: (repo) => void woken.push(repo),
      log: () => {},
    });
    const body = JSON.stringify({ ref: `refs/tags/${TAG}`, repository: { full_name: "acme/web" } });
    const res = await handler.handle(
      new Request("http://x/api/v1/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "x-github-event": "push",
          "x-github-delivery": "99999999-2222-3333-4444-555555555555",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`,
        },
      }),
      "203.0.113.9",
    );
    expect(res!.status).toBe(401);
    expect(woken).toEqual([]);
  });
});

describe("one negative per gate: nothing is signed, nothing is published", () => {
  const untouched = (x: World): void => {
    expect(x.net.writes).toEqual([]);
    expect(x.net.npm.size).toBe(0);
    expect(x.net.release).toBeUndefined();
  };

  test("an untrusted run's artifact: a fork's run is not release class, so the signer refuses it", async () => {
    w = await world({ fork: true });
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({
      status: "refused",
      reason: "signer:not_release_class",
    });
    untouched(w);
  });

  test("an artifact written by a lower-class attempt of a release run: the signer refuses it", async () => {
    w = await world({ lowerTarball: "trusted_pr" });
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({
      status: "refused",
      reason: "signer:artifact_not_release_class",
    });
    untouched(w);
  });

  test("a moved tag: the forge now says the tag is another commit", async () => {
    w = await world();
    w.net.tags.set(TAG, "b".repeat(40));
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "refused", reason: "sha_mismatch" });
    untouched(w);
  });

  test("artifact bytes changed after they were recorded: the lane's own digest differs", async () => {
    w = await world({ tamperBytes: true });
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    untouched(w);
  });

  test("a missing approval: the quorum was never reached, so the signer refuses", async () => {
    w = await world({ approve: false });
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "refused", reason: "signer:no_approval" });
    expect(await w.signAudits()).toContain("denied:no_approval");
    untouched(w);
  });

  test("an incident freeze: the request is not even claimed, and is processed once it clears", async () => {
    w = await world();
    const id = await w.request();
    await setFreeze(w.db, w.scope, { by: "test", reason: "incident", now: Date.now() });
    expect(await w.lane.processNext()).toBe(false);
    expect((await w.state(id)).status).toBe("pending");
    untouched(w);
    await clearFreeze(w.db, w.scope);
    expect(await w.lane.processNext()).toBe(true);
    expect((await w.state(id)).status).toBe("signed");
    expect(w.net.npm.size).toBe(1);
  });
});

const CONFIG_CHANGED = "release lane config changed since approval; re-approve";

describe("the approval binds the lane's configuration version (#541)", () => {
  const bump = (): void => void w.attest.bumpConfigVersion();
  const detailOf = async (id: string): Promise<string | null> =>
    (await getReleaseRequest(w.db, w.scope, id))!.detail;

  test("the statement the approver signs carries the lane's version at the time of the challenge", async () => {
    w = await world({ approve: false });
    const v = w.attest.configVersion();
    expect(v).toBeGreaterThan(0);
    // a challenge issued now names the version now; after a change it names the new one
    const opTok = (await mintToken(w.db, { orgId: w.orgId }, "operator")).secret;
    const issue = async (): Promise<number> => {
      const r = await dispatch(
        { registry, db: w.db, releaseConfig: laneVersionOf(w.attest) },
        { kind: "bearer", token: opTok },
        "release_approval_challenge",
        {
          run_id: w.runId,
          approver: (await anApprover(w)).id,
          project: "web",
        },
      );
      if (!r.ok) throw new Error(r.error.message);
      return (r.output as { statement: { lane_config_version: number } }).statement
        .lane_config_version;
    };
    expect(await issue()).toBe(v);
    bump();
    expect(await issue()).toBe(v + 1);
  });

  test("a statement without the field is not a v2 statement and is never accepted", async () => {
    const { lane_config_version: _drop, ...rest } = {
      type: RELEASE_STATEMENT_TYPE,
      org: "acme",
      project: "web",
      run_id: "r1",
      head_sha: "a".repeat(40),
      workflow_hash: "ab".repeat(32),
      environment: "release",
      manifest_sha256: "c".repeat(64),
      lane_config_version: 1,
      approver: "ap",
      expires_at: 1,
      nonce: "n".repeat(20),
    };
    expect(releaseStatementSchema.safeParse(rest).success).toBe(false);
    expect(releaseStatementSchema.safeParse({ ...rest, lane_config_version: 1 }).success).toBe(
      true,
    );
    expect(releaseStatementSchema.safeParse({ ...rest, lane_config_version: -1 }).success).toBe(
      false,
    );
  });

  test("approve, change the config, then SIGNING is refused with the exact reason; nothing is published", async () => {
    w = await world();
    bump();
    const id = await w.request();
    expect(await w.lane.processNext()).toBe(true);
    expect(await w.state(id)).toMatchObject({ status: "refused", reason: "signer:config_changed" });
    expect(await detailOf(id)).toBe(CONFIG_CHANGED);
    expect(await w.signAudits()).toContain("denied:config_changed");
    expect(w.net.npm.size).toBe(0);
    expect(w.net.release).toBeUndefined();
  });

  test("approving again under the new version signs and publishes", async () => {
    w = await world();
    bump();
    const first = await w.request();
    await w.lane.processNext();
    expect(await w.state(first)).toMatchObject({ reason: "signer:config_changed" });
    await w.reapprove();
    const second = await w.request();
    await w.lane.processNext();
    expect(await w.state(second)).toMatchObject({ status: "signed" });
    expect(w.net.npm.size).toBe(1);
  });

  test("approve, sign, change the config, then PUBLISH is refused; approving again publishes", async () => {
    w = await world();
    // sign with no targets declared (a signature is not a publish), then declare them again
    const targets = w.attest.publishTargets(w.scope.orgId, w.scope.projectId);
    for (const key of Object.keys(targets)) {
      w.attest.removePublishTarget(w.scope.orgId, w.scope.projectId, key);
    }
    // the approval was given under the version before these removals: refresh it, as an approver
    // would, so the signature below is under the current version
    await w.reapprove();
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "signed" });
    for (const [key, t] of Object.entries(targets)) {
      w.attest.setPublishTarget(w.scope.orgId, w.scope.projectId, key, t, Date.now());
    }
    const refused = await w.lane.finalize({ ...w.scope, runId: w.runId });
    expect(refused.map((r) => [r.target, r.state, r.reason])).toEqual([
      ["npm", "refused", CONFIG_CHANGED],
      ["release", "refused", CONFIG_CHANGED],
    ]);
    expect(w.net.npm.size).toBe(0);
    expect(w.net.release).toBeUndefined();
    // approve again (the release job waits again), sign again: published
    await w.reapprove();
    const again = await w.request();
    await w.lane.processNext();
    expect(await w.state(again)).toMatchObject({ status: "signed" });
    expect(w.net.npm.size).toBe(1);
  });
});

describe("get_release_request serves the lane's provenance, and it verifies against release_public_key", () => {
  async function signedWorld() {
    w = await world();
    const id = await w.request();
    await w.lane.processNext();
    expect(await w.state(id)).toMatchObject({ status: "signed" });
    const h = await opsHarness({ db: w.db, attest: w.attest, orgId: w.orgId, keys: w.keys });
    const reader = (await mintToken(w.db, { orgId: w.orgId }, "reader")).secret;
    const ask = (tok: string, op: string, input: Record<string, unknown>, transport = "rest") =>
      dispatch(
        { ...h.env, allowInstance: false, transport: transport as "rest" | "mcp" },
        { kind: "bearer", token: tok },
        op,
        input,
      );
    const pub = await ask(reader, "release_public_key", { name: "release" });
    if (!pub.ok) throw new Error(`public key: ${pub.error.message}`);
    const d = mkdtempSync(join(tmp, "prov-"));
    writeFileSync(join(d, "cli-linux"), w.binary);
    writeFileSync(
      join(d, "release.pub"),
      (pub.output as { public_key_pem: string }).public_key_pem,
    );
    return { id, h, pub, d, ask };
  }

  test("the envelope verifies with `turntable verify` against the PEM release_public_key returns", async () => {
    const { id, h, pub, d } = await signedWorld();
    try {
      expect((pub.output as { public_key_pem: string }).public_key_pem).toBe(w.publicKeyPem);
      const got = await dispatch(
        { registry, db: w.db },
        { kind: "bearer", token: w.releaseTok },
        "get_release_request",
        { id, project: "web" },
      );
      expect(got.ok).toBe(true);
      const out = got.ok
        ? (got.output as { status: string; provenance: string | null })
        : undefined;
      expect(out!.status).toBe("signed");
      expect(typeof out!.provenance).toBe("string");
      writeFileSync(join(d, "provenance.json"), out!.provenance!);
      const ok = await verify(
        join(d, "cli-linux"),
        join(d, "provenance.json"),
        join(d, "release.pub"),
      );
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("cli-linux");
    } finally {
      h.dispose();
    }
  });

  test("a tampered envelope in the row fails verification; an unsigned request has none", async () => {
    const { id, h, d } = await signedWorld();
    try {
      // someone with write access to the main database edits the stored envelope's payload
      await w.db.run(async (x) => {
        const [row] = await x.orm
          .select()
          .from(schema.releaseRequests)
          .where(eq(schema.releaseRequests.id, id));
        const result = JSON.parse(row!.result!) as { envelope: { payload: string } };
        const payload = JSON.parse(Buffer.from(result.envelope.payload, "base64").toString("utf8"));
        payload.subject[0].digest.sha256 = "0".repeat(64);
        result.envelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
        await x.orm
          .update(schema.releaseRequests)
          .set({ result: JSON.stringify(result) })
          .where(eq(schema.releaseRequests.id, id));
      });
      const got = await dispatch(
        { registry, db: w.db },
        { kind: "bearer", token: w.releaseTok },
        "get_release_request",
        { id, project: "web" },
      );
      const prov = got.ok ? (got.output as { provenance: string }).provenance : "";
      writeFileSync(join(d, "provenance.json"), prov);
      const bad = await verify(
        join(d, "cli-linux"),
        join(d, "provenance.json"),
        join(d, "release.pub"),
      );
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("NOT VERIFIED");
    } finally {
      h.dispose();
    }
  });

  test("a pending or refused request has provenance null", async () => {
    w = await world({ tamperBytes: true });
    const id = await w.request();
    const pending = await dispatch(
      { registry, db: w.db },
      { kind: "bearer", token: w.releaseTok },
      "get_release_request",
      { id, project: "web" },
    );
    expect(pending.ok && (pending.output as { provenance: unknown }).provenance).toBeNull();
    await w.lane.processNext();
    const refused = await dispatch(
      { registry, db: w.db },
      { kind: "bearer", token: w.releaseTok },
      "get_release_request",
      { id, project: "web" },
    );
    expect(refused.ok && (refused.output as { status: string }).status).toBe("refused");
    expect(refused.ok && (refused.output as { provenance: unknown }).provenance).toBeNull();
  });
});
