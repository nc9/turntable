// Adopting attempts that hold credentials (#787): the secrets-proxy credential and CA, the job's
// GitHub token behind the proxy and the artifact grant are rebuilt by the next controller from the
// master key, never stored, and an attempt whose credential cannot be rebuilt fails closed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { planJob, sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { AttemptRegistry } from "@turntable/proxy";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { ArtifactGrants } from "../src/artifacts/grants";
import { jobArtifactProvider } from "../src/artifacts/job";
import type { ArtifactService } from "../src/artifacts/service";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
  recordExec,
  recordPlan,
  recordTrustClass,
  type Scope,
} from "../src/db";
import { getAttempt, getJob, getRun, setProxyRule } from "../src/db/repos";
import * as s from "../src/db/schema";
import { JobTokens, type TokenAuthority } from "../src/github/job-token";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { SecretsProxy, withSecretsProxy, type ProxyAccess } from "../src/proxy";
import { createActRunner, reconcileExpired, Scheduler } from "../src/scheduler";
import {
  type AdoptSpec,
  attemptSeeds,
  type AttemptSeeds,
  parseAdoptSpec,
} from "../src/scheduler/adopt-credentials";
import { DrainState } from "../src/scheduler/drain";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { SecretVault } from "../src/secrets/vault";
import { makeGithub } from "./github-stub";
import { seedWorld, type Tenant } from "./ops-helpers";

// Built at runtime: no secret-like literal in the repository.
const VALUE = `adopt-${randomBytes(8).toString("hex")}`;
const HOST = "api.example.test";
const ADVERTISE = { advertiseHost: "proxy.example.test", advertisePort: 8443 };

/** What a job's step does through the proxy: CONNECT with the sandbox's credential, TLS with its CA. */
async function stepThrough(
  port: number,
  cred: { username: string; password: string; caPem: string },
): Promise<{ status: number; body: string }> {
  const raw = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => raw.once("connect", () => r()));
  const basic = Buffer.from(`${cred.username}:${cred.password}`).toString("base64");
  raw.write(
    `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
  );
  const answer = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
  if (!answer.startsWith("HTTP/1.1 200")) {
    raw.destroy();
    return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(answer)?.[1]), body: "" };
  }
  const secure = tls.connect({ socket: raw, servername: HOST, ca: cred.caPem });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", () => resolve());
    secure.once("error", reject);
  });
  secure.write(`GET /v1/pkg HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  for await (const d of secure) chunks.push(d as Buffer);
  const text = Buffer.concat(chunks).toString();
  return {
    status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]),
    body: text.split("\r\n\r\n")[1] ?? "",
  };
}

describe("derived proxy credentials", () => {
  test("the same seed and time give the same password and a CA whose leaves the first CA verifies", () => {
    const seed = randomBytes(32);
    const spec = {
      attemptId: "att_1",
      orgId: "o",
      projectId: "p",
      runId: "r",
      jobId: "j",
      rules: [],
      ttlMs: 3_600_000,
    };
    const issuedAt = Date.now() - 60_000;
    const a = new AttemptRegistry().register(spec, { seed, issuedAt });
    const regB = new AttemptRegistry();
    const b = regB.register(spec, { seed, issuedAt });
    expect(b.password).toBe(a.password);
    expect(b.expiresAt).toBe(a.expiresAt);
    // The adopter's leaf for a host verifies against the CA certificate the sandbox was given.
    const auth = regB.authenticate(
      `Basic ${Buffer.from(`att_1:${a.password}`).toString("base64")}`,
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const leaf = new X509Certificate(auth.attempt.ca.leafFor(HOST).cert);
    expect(leaf.verify(new X509Certificate(a.caPem).publicKey)).toBe(true);
    // Another seed: another password, and a CA the sandbox's does not match.
    const c = new AttemptRegistry().register(spec, { seed: randomBytes(32), issuedAt });
    expect(c.password).not.toBe(a.password);
    expect(
      new X509Certificate(c.caPem).publicKey.equals(new X509Certificate(a.caPem).publicKey),
    ).toBe(false);
  });

  test("an expired credential is not registered again", () => {
    const spec = {
      attemptId: "att_2",
      orgId: "o",
      projectId: "p",
      runId: "r",
      jobId: "j",
      rules: [],
      ttlMs: 1000,
    };
    expect(() =>
      new AttemptRegistry().register(spec, { seed: randomBytes(32), issuedAt: Date.now() - 5000 }),
    ).toThrow("expired");
  });

  test("seeds differ by purpose, org, attempt and master key", () => {
    const k = randomBytes(32);
    const seeds = attemptSeeds(k);
    const who = { orgId: "o", attemptId: "a" };
    const base = seeds("proxy", who).toString("hex");
    expect(seeds("proxy", who).toString("hex")).toBe(base);
    expect(seeds("artifact", who).toString("hex")).not.toBe(base);
    expect(seeds("proxy", { orgId: "o2", attemptId: "a" }).toString("hex")).not.toBe(base);
    expect(seeds("proxy", { orgId: "o", attemptId: "b" }).toString("hex")).not.toBe(base);
    expect(attemptSeeds(randomBytes(32))("proxy", who).toString("hex")).not.toBe(base);
  });
});

describe("re-registering an adopted attempt behind the proxy", () => {
  let db: Db;
  let a: Tenant;
  let vault: SecretVault;
  let master: Buffer;
  let upstreamSaw: Headers[];
  const proxies: SecretsProxy[] = [];

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    master = randomBytes(32);
    vault = new SecretVault({ db, masterKey: master });
    upstreamSaw = [];
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }) })
      .where(eq(s.runs.id, a.runId));
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    await vault.set(a.orgId, "t", { name: "NPM_TOKEN", projectId: a.projectId }, VALUE, {
      destinations: [HOST],
    });
    await setProxyRule(db, a.scope, "t", {
      name: "npm",
      secret: "NPM_TOKEN",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
  });
  afterEach(async () => {
    for (const p of proxies.splice(0)) await p.stop();
  });

  const start = async (o: { seeds?: AttemptSeeds; port?: number } = {}) => {
    const p = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      ...ADVERTISE,
      ...(o.port ? { advertisePort: o.port } : {}),
      ...(o.seeds ? { seeds: o.seeds } : {}),
      upstream: async (_u, init) => {
        upstreamSaw.push(new Headers(init?.headers));
        return new Response(`echo ${VALUE}`);
      },
      tunnel: async () => {
        throw new Error("no passthrough here");
      },
    });
    proxies.push(p);
    return p;
  };

  const ctxOf = async (extra: Partial<AttemptContext> = {}): Promise<AttemptContext> => ({
    run: (await getRun(db, a.scope, a.runId))!,
    job: (await getJob(db, a.scope, a.jobId))!,
    attempt: (await getAttempt(db, a.scope, a.attemptId))!,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
    ...extra,
  });

  const done: AttemptOutcome = { state: "success", reason: "ok" };

  /** The first controller: registers, hands the job its credential, and lets go (a hand-off). */
  async function firstController(seeds: AttemptSeeds): Promise<ProxyAccess> {
    const p = await start({ seeds });
    let access: ProxyAccess | undefined;
    await withSecretsProxy(async (c) => ((access = c.proxy), done), { proxy: p })(await ctxOf());
    await p.stop();
    expect(access?.adopt).toBeDefined();
    return access!;
  }

  const resumed = async (adopt: ProxyAccess["adopt"]) =>
    ctxOf({
      resume: { sandboxId: "sb", execId: "ex" },
      attempt: {
        ...(await getAttempt(db, a.scope, a.attemptId))!,
        adoptSpec: JSON.stringify({ v: 1, proxy: adopt! } satisfies AdoptSpec),
      },
    });

  test("the next controller's proxy takes the sandbox's credential and CA, and injects the secret", async () => {
    const seeds = attemptSeeds(master);
    const first = await firstController(seeds);
    // The spec stored with the attempt holds no secret: not the password, not the value.
    const stored = JSON.stringify({ v: 1, proxy: first.adopt });
    expect(stored).not.toContain(first.credential.password);
    expect(stored).not.toContain(VALUE);

    const next = await start({ seeds });
    let step: { status: number; body: string } | undefined;
    let password = "";
    const out = await withSecretsProxy(
      async (c) => {
        password = c.proxy!.credential.password;
        // A secret-using step after the hand-off, with what the sandbox already holds.
        step = await stepThrough(next.port, first.credential);
        return done;
      },
      { proxy: next },
    )(await resumed(first.adopt));
    expect(out.state).toBe("success");
    expect(password).toBe(first.credential.password);
    expect(step?.status).toBe(200);
    expect(upstreamSaw[0]?.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(step?.body).not.toContain(VALUE);
    // Released when the adopted attempt ends: the credential is dead again.
    expect(next.active).toBe(0);
    expect((await stepThrough(next.port, first.credential)).status).toBe(407);
  });

  test("another master key, other rules, another endpoint or no seeds: refused as a lost controller, never run", async () => {
    const first = await firstController(attemptSeeds(master));
    const refusedWith = async (proxy: SecretsProxy): Promise<AttemptOutcome> => {
      let ran = false;
      const out = await withSecretsProxy(async () => ((ran = true), done), { proxy })(
        await resumed(first.adopt),
      );
      expect(ran).toBe(false);
      expect(out.state).toBe("infra_error");
      expect(out.reason).toContain("lost its secrets-proxy credential");
      return out;
    };
    expect(
      (await refusedWith(await start({ seeds: attemptSeeds(randomBytes(32)) }))).reason,
    ).toContain("master key");
    expect((await refusedWith(await start({}))).reason).toContain("derives no proxy credentials");
    expect(
      (await refusedWith(await start({ seeds: attemptSeeds(master), port: 9443 }))).reason,
    ).toContain("endpoint");
    await setProxyRule(db, a.scope, "t", {
      name: "npm2",
      secret: "NPM_TOKEN",
      host: HOST,
      port: 443,
      methods: ["POST"],
      pathPrefix: "/v2/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
    expect((await refusedWith(await start({ seeds: attemptSeeds(master) }))).reason).toContain(
      "rules changed",
    );
  });

  test("an older attempt with no spec keeps the old rule: refused when it had vault rules", async () => {
    const p = await start({ seeds: attemptSeeds(master) });
    let ran = false;
    const out = await withSecretsProxy(async () => ((ran = true), done), { proxy: p })(
      await ctxOf({ resume: { sandboxId: "sb", execId: "ex" } }),
    );
    expect(ran).toBe(false);
    expect(out.state).toBe("infra_error");
  });
});

describe("the artifact grant and the job token", () => {
  test("an adopted grant is the same token, in the next controller's grants; another key gets none", () => {
    const seeds = attemptSeeds(randomBytes(32));
    const service = (grants: ArtifactGrants) =>
      ({ grants, resultsUrl: "https://ci.example.test/" }) as unknown as ArtifactService;
    const req = {
      runId: "run_1",
      attemptId: "att_1",
      scope: { orgId: "o", projectId: "p" },
      klass: "protected" as const,
      egress: "none" as const,
      proxyRoute: true,
      local: false,
    };
    const first = jobArtifactProvider(service(new ArtifactGrants()), { seeds })(req)!;
    expect(first.adopt?.mode).toBe("upload");
    expect(JSON.stringify(first.adopt)).not.toContain(first.token.split(".")[2]!);
    const grantsB = new ArtifactGrants();
    const again = jobArtifactProvider(service(grantsB), { seeds })({ ...req, adopt: first.adopt! });
    expect(again?.token).toBe(first.token);
    expect(grantsB.verify(first.token)?.attemptId).toBe("att_1");
    // Another master key, or a grant past its life: none, so the attempt is refused.
    const other = attemptSeeds(randomBytes(32));
    expect(
      jobArtifactProvider(service(new ArtifactGrants()), { seeds: other })({
        ...req,
        adopt: first.adopt!,
      }),
    ).toBeUndefined();
    expect(
      jobArtifactProvider(service(new ArtifactGrants()), { seeds })({
        ...req,
        adopt: { ...first.adopt!, issuedAt: Date.now() - 3 * 3600_000 },
      }),
    ).toBeUndefined();
  });

  test("a re-issued job token has the stored permissions, lowered to read when the project is not live", async () => {
    const minted: Record<string, string>[] = [];
    const auth: TokenAuthority = {
      mintFresh: async (_i, scope) => {
        minted.push({ ...scope.permissions });
        return { token: `tok-${minted.length}`, expiresAt: Date.now() + 3600_000 };
      },
      installationPermissions: async () => ({}),
      revoke: async () => true,
    };
    const tokens = new JobTokens(auth);
    const r = await tokens.reissue({
      installationId: "1",
      repo: "web",
      permissions: { contents: "write", metadata: "read" },
    });
    expect(r.permissions).toEqual({ contents: "write", metadata: "read" });
    await tokens.reissue({
      installationId: "1",
      repo: "web",
      permissions: { contents: "write", metadata: "read" },
      readOnly: true,
    });
    expect(minted[1]).toEqual({ contents: "read", metadata: "read" });
    await expect(
      tokens.reissue({ installationId: "1", repo: "web", permissions: { contents: "admin" } }),
    ).rejects.toThrow();
  });
});

// End to end with the fake provider and two proxies. Controller A registered the attempt behind
// its proxy (with the master key's seeds), started act and died or handed off; its proxy is gone.
// Controller B (a new process: a new proxy, the same master key) adopts it. The job's secret-using
// step after the hand-off works with the credential and CA the sandbox already holds, and the job
// finishes with its real result. (The fake provider cannot confine a sandbox to a proxy, so A's
// sandbox and exec are made directly, as a reconcile finds them.)
describe("a proxied attempt taken over by the next controller", () => {
  const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures/success.jsonl");
  const WORKFLOW =
    "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
  let world: FakeWorld;
  let tmp: string;
  beforeEach(() => {
    world = new FakeWorld();
    tmp = mkdtempSync(join(tmpdir(), "tt-adopt-cred-"));
  });
  afterEach(() => {
    world.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("B re-registers it, the step after the hand-off uses the secret, and the job succeeds", async () => {
    const provider = world.provider();
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "a", name: "a" });
    const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
    const scope = { orgId: org.id, projectId: project.id };
    const master = randomBytes(32);
    const seeds = attemptSeeds(master);
    const vault = new SecretVault({ db, masterKey: master });
    await vault.set(org.id, "t", { name: "NPM_TOKEN", projectId: project.id }, VALUE, {
      destinations: [HOST],
    });
    await setProxyRule(db, scope, "t", {
      name: "npm",
      secret: "NPM_TOKEN",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
    const run = await createRun(db, scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "a".repeat(40),
    });
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }) })
      .where(eq(s.runs.id, run.id));
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "hello", name: "hello" }))!;
    const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
    await claimNextAttempt(db, { owner: "dead", leaseMs: 1, now: 1, globalCap: 99, perOrgCap: 99 });
    await recordTrustClass(db, scope, attempt.id, "dead", "protected");

    const saw: string[] = [];
    const startProxy = () =>
      SecretsProxy.start({
        db,
        vault,
        bindHost: "127.0.0.1",
        ...ADVERTISE,
        seeds,
        upstream: async (_u, init) => {
          saw.push(new Headers(init?.headers).get("authorization") ?? "");
          return new Response("ok");
        },
        tunnel: async () => {
          throw new Error("no passthrough here");
        },
      });

    // Controller A: registers the attempt behind its proxy; the sandbox is given this credential.
    const proxyA = await startProxy();
    let held: ProxyAccess | undefined;
    await withSecretsProxy(async (c) => ((held = c.proxy), { state: "success", reason: "" }), {
      proxy: proxyA,
    })({
      run: (await getRun(db, scope, run.id))!,
      job: (await getJob(db, scope, job.id))!,
      attempt: (await getAttempt(db, scope, attempt.id))!,
      scope,
      provider,
      signal: new AbortController().signal,
      store: {} as AttemptContext["store"],
    });
    await proxyA.stop();
    // act in its sandbox: the step starts, then waits for its cue (the test's step below).
    const go = join(tmp, "go");
    const sb = await provider.create({
      name: "job",
      labels: {},
      ttlSeconds: 600,
      network: { egress: "none" },
    });
    const { execId } = await provider.exec.start(sb.id, {
      argv: [
        "sh",
        "-c",
        `head -n 6 '${FIXTURE}'; i=0; while [ ! -f '${go}' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; tail -n +7 '${FIXTURE}'`,
      ],
      timeoutSeconds: 60,
    });
    const plan = planJob(WORKFLOW, "hello", {
      workflowPath: "w.yml",
      event: "push",
      readFile: () => undefined,
    });
    const spec = { v: 1, proxy: held!.adopt! } satisfies AdoptSpec;
    await recordExec(db, scope, attempt.id, "dead", {
      sandboxId: sb.id,
      execId,
      adoptBlock: null,
      adoptSpec: JSON.stringify(spec),
    });
    await recordPlan(db, scope, attempt.id, "dead", JSON.stringify(plan));
    const stored = (await getAttempt(db, scope, attempt.id))!;
    expect(stored.adoptSpec).not.toContain(held!.credential.password);
    expect(stored.adoptSpec).not.toContain(VALUE);

    // Controller B.
    const proxyB = await startProxy();
    try {
      const b = new Scheduler({
        db,
        owner: "controller-b",
        providers: () => provider,
        runner: withSecretsProxy(
          createActRunner({
            db,
            source: {
              checkout: async () => ({
                tarball: new Uint8Array(),
                readFile: (p: string) => (p === "w.yml" ? WORKFLOW : undefined),
              }),
            },
            pollMs: 20,
          }),
          { proxy: proxyB },
        ),
        leaseMs: 60_000,
        drain: new DrainState(),
      });
      const rec = await reconcileExpired(db, () => provider, {
        owner: b.owner,
        leaseMs: 60_000,
        adopt: (c, x) => void b.adopt(c, x),
      });
      expect(rec.adopted).toHaveLength(1);
      await until(async () => proxyB.active === 1);
      // The job's secret-using step after the hand-off, with what its sandbox holds.
      const step = await stepThrough(proxyB.port, held!.credential);
      expect(step.status).toBe(200);
      expect(saw).toEqual([`Bearer ${VALUE}`]);
      writeFileSync(go, "");
      await b.idle();
      const done = (await listAttempts(db, scope, job.id))[0]!;
      expect(done.state).toBe("success");
      expect(proxyB.active).toBe(0);
      // The log has the job's output and neither the secret nor the proxy password.
      const log = Buffer.concat(
        (await readLog(db, scope, attempt.id)).map((c) => c.bytes),
      ).toString();
      expect(log).toContain("hello from act");
      expect(log).not.toContain(VALUE);
      expect(log).not.toContain(held!.credential.password);
    } finally {
      await proxyB.stop();
    }
  }, 30_000);

  test("a fresh proxied attempt records no block and a spec with no secret in it", async () => {
    // The fake provider then refuses to run it (it cannot confine a sandbox to the proxy): what
    // matters here is what was recorded before the exec would start.
    const db = openDatabase(":memory:");
    const scope: Required<Scope> = await ensureLocalTenant(db);
    const master = randomBytes(32);
    const vault = new SecretVault({ db, masterKey: master });
    const wf = WORKFLOW;
    const gh = makeGithub();
    gh.state.files.set("*", wf);
    await pollRepo(
      {
        db,
        github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
        provider: "fake",
      },
      pollConfigSchema.parse({
        allowUnauthenticated: true,
        repos: [
          {
            repo: "acme/web",
            workflow: ".github/workflows/ci.yml",
            defaultBranch: "main",
            prMode: "allowlist",
            prBaseline: false,
            authors: ["octocat"],
          },
        ],
      }).repos[0] as PollRepoConfig,
    );
    const [r] = await listRuns(db, scope);
    const hash = createHash("sha256").update(wf).digest("hex");
    await db.orm
      .update(s.runs)
      .set({
        trust: JSON.stringify({ class: "protected", workflowHash: hash }),
        approval: JSON.stringify({ head_sha: r!.sha?.toLowerCase(), workflow_hash: hash }),
      })
      .where(eq(s.runs.id, r!.id));
    const [job] = await listJobs(db, scope, r!.id);
    await vault.set(scope.orgId, "t", { name: "NPM_TOKEN", projectId: scope.projectId }, VALUE, {
      destinations: [HOST],
    });
    await setProxyRule(db, scope, "t", {
      name: "npm",
      secret: "NPM_TOKEN",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
    const proxy = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      seeds: attemptSeeds(master),
      upstream: async () => new Response("unused"),
      tunnel: async () => {
        throw new Error("unused");
      },
    });
    try {
      const d = mkdtempSync(join(tmp, "a-"));
      writeFileSync(join(d, "act"), "#!/bin/sh\n", { mode: 0o755 });
      const bytes = await tarDirectory(d, ["act"]);
      const sched = new Scheduler({
        db,
        providers: () => world.provider(),
        runner: withSecretsProxy(
          createActRunner({
            db,
            source: {
              checkout: async () => ({
                tarball: await tarDirectory(d, ["act"]),
                readFile: (p: string) => (p === ".github/workflows/ci.yml" ? wf : undefined),
              }),
            },
            resolver: staticResolver({}),
            act: { bytes, sha256: sha256Hex(bytes) },
            planRoot: join(tmp, "root"),
            pollMs: 20,
          }),
          { proxy },
        ),
        globalCap: 1,
        perOrgCap: 1,
        leaseMs: 60_000,
        pollMs: 20,
      });
      await sched.tick();
      await sched.idle();
      const [att] = await listAttempts(db, scope, job!.id);
      expect(att!.adoptBlock).toBeNull();
      const spec = parseAdoptSpec(att!.adoptSpec);
      expect(spec?.proxy?.endpoint).toBe(proxy.endpoint);
      expect(spec?.proxy?.check).toMatch(/^[0-9a-f]{32}$/);
      expect(att!.adoptSpec).not.toContain(VALUE);
    } finally {
      await proxy.stop();
    }
  });
});

async function until(f: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}
