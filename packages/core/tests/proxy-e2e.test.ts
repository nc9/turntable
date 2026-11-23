import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { planJob, resolveActions, staticResolver, tarDirectory } from "@longshore/act-runner";
import { DockerProvider } from "@longshore/provider-docker";
import { SecretRegistry } from "@longshore/redact";
import { type Db } from "../src/db";
import { getAttempt, getJob, getRun, listAudit, setProxyRule } from "../src/db/repos";
import * as s from "../src/db/schema";
import { SecretsProxy, withSecretsProxy } from "../src/proxy";
import { DEFAULT_IMAGE, executeJob } from "../src/run/job-exec";
import type { RunStore } from "../src/run/store";
import type { AttemptContext } from "../src/scheduler/types";
import { SecretVault } from "../src/secrets/vault";
import { seedWorld, type Tenant } from "./ops-helpers";

// CI only (TT_PROXY_E2E=1): a real Docker daemon on Linux. A sandbox on an internal network, a
// relay to the controller's proxy, and a job whose step calls an API through it. The upstream is a
// recording stand-in injected into the proxy (the real client refuses internal addresses).
const enabled = process.env.TT_PROXY_E2E === "1";
const IMAGE = process.env.TT_ACT_IMAGE ?? DEFAULT_IMAGE;
const VALUE = "e2e-secret-value-4c2a91";
const HOST = "api.example.test";
const tmp = mkdtempSync(join(tmpdir(), "tt-proxy-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function git(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(
    [
      "git",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      ...args,
    ],
    {
      cwd: dir,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

let db: Db;
let a: Tenant;
let vault: SecretVault;
let proxy: SecretsProxy;
const upstreamSaw: Headers[] = [];

beforeAll(async () => {
  if (!enabled) return;
  ({ db, a } = await seedWorld());
  vault = new SecretVault({ db, masterKey: randomBytes(32) });
  proxy = await SecretsProxy.start({
    db,
    vault,
    upstream: async (_u, init) => {
      upstreamSaw.push(new Headers(init?.headers));
      return new Response(`pong; you sent ${new Headers(init?.headers).get("authorization")}`, {
        headers: { "content-type": "text/plain" },
      });
    },
    tunnel: async () => {
      throw new Error("passthrough is not enabled in this test");
    },
  });
});
afterAll(async () => {
  await proxy?.stop();
});

describe.skipIf(!enabled)("a job behind the secrets proxy (docker, Linux)", () => {
  test("injected upstream, no secret in the sandbox or the log, no way around, gone after", async () => {
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }), plan: null })
      .where(eq(s.runs.id, a.runId));
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    await vault.set(a.orgId, "t", { name: "API_TOKEN", projectId: a.projectId }, VALUE, {
      destinations: [HOST],
    });
    await setProxyRule(db, a.scope, "t", {
      name: "api",
      secret: "API_TOKEN",
      host: HOST,
      port: 443,
      methods: ["GET"],
      pathPrefix: "/v1/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });

    const repo = join(tmp, "repo");
    cpSync(join(import.meta.dir, "../../../examples/hello"), repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "initial example commit");
    const repoTarball = await tarDirectory(repo);
    const yaml = readFileSync(join(repo, ".github/workflows/proxy.yml"), "utf8");
    const planned = planJob(yaml, "proxy", {
      workflowPath: ".github/workflows/proxy.yml",
      readFile: (f) =>
        existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : undefined,
    });
    const plan = await resolveActions(planned, staticResolver({}));

    const provider = new DockerProvider();
    let logText = "";
    let access: AttemptContext["proxy"];
    const store = {
      setSandbox: async () => {},
      setExec: async () => {},
      resetOutput: async () => {},
      appendLog: async () => {},
      recordStep: async () => {},
      finishJob: async () => {},
    } as unknown as RunStore;

    const runner = withSecretsProxy(
      async (ctx) => {
        access = ctx.proxy;
        const out = await executeJob(
          {
            provider,
            store,
            image: IMAGE,
            repoTarball,
            out: (t) => {
              logText += t;
            },
            registry: ctx.redact ?? new SecretRegistry(),
            signal: ctx.signal,
            timeoutSeconds: 300,
            ...(ctx.proxy ? { proxy: ctx.proxy } : {}),
          },
          { runId: a.runId, jobId: a.jobId, attemptId: a.attemptId },
          plan,
        );
        return { state: out.state === "success" ? "success" : "failure", reason: out.reason };
      },
      { proxy },
    );
    const ctx: AttemptContext = {
      run: (await getRun(db, a.scope, a.runId))!,
      job: (await getJob(db, a.scope, a.jobId))!,
      attempt: (await getAttempt(db, a.scope, a.attemptId))!,
      scope: a.scope,
      provider,
      signal: new AbortController().signal,
      store: {} as AttemptContext["store"],
    };
    const outcome = await runner(ctx);
    if (outcome.state !== "success") console.log(outcome, "\n" + logText);

    expect(outcome.state).toBe("success");
    expect(access).toBeDefined();
    // The step reached the API through the proxy, and the upstream saw the injected header.
    expect(logText).toContain("proxy-env-set=yes");
    expect(logText).toContain("api-status=200");
    expect(upstreamSaw[0]?.get("authorization")).toBe(`Bearer ${VALUE}`);
    // The value is nowhere the job can see it: not its env, and not its log (the echo is scrubbed
    // by the proxy, and the log redactor is the backstop).
    expect(logText).toContain("env-leak=no");
    expect(logText).not.toContain(VALUE);
    expect(logText).not.toContain(Buffer.from(VALUE).toString("base64"));
    // No route but the proxy, and a host with no rule is refused.
    expect(logText).toContain("direct=blocked");
    expect(logText).toContain("other=refused");
    // The vault and the proxy both audited the use.
    const ops = (await listAudit(db, a.scope)).map((r) => r.op);
    expect(ops).toContain("secret_use");
    expect(ops).toContain("proxy_inject");
    expect(ops).toContain("proxy_deny");
    // After the attempt the rule is gone: the credential is revoked and its tunnels are closed.
    expect(proxy.active).toBe(0);
    const raw = net.connect(proxy.port, proxy.host);
    await new Promise<void>((r) => raw.once("connect", () => r()));
    const basic = Buffer.from(
      `${access!.credential.username}:${access!.credential.password}`,
    ).toString("base64");
    raw.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
    );
    const answer = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
    expect(answer.startsWith("HTTP/1.1 407")).toBe(true);
    raw.destroy();
    // And nothing of the sandbox is left: no container, relay or network for this attempt.
    expect(await provider.list({ labels: { "longshore.run": a.runId } })).toHaveLength(0);
  }, 600_000);

  test("GITHUB_TOKEN in a job is a placeholder, the proxy attaches the real token to the repository's API only", async () => {
    // Built at run time: a literal in this shape trips secret scanners.
    const TOKEN = ["ghs", "e2e", "job", "token", "7d41c0"].join("_");
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "protected", workflowHash: "h" }), plan: null })
      .where(eq(s.runs.id, a.runId));
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    upstreamSaw.length = 0;

    const repo = join(tmp, "repo-token");
    cpSync(join(import.meta.dir, "../../../examples/hello"), repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "initial example commit");
    const repoTarball = await tarDirectory(repo);
    const yaml = readFileSync(join(repo, ".github/workflows/github-token.yml"), "utf8");
    const planned = planJob(yaml, "token", {
      workflowPath: ".github/workflows/github-token.yml",
      readFile: (f) =>
        existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : undefined,
    });
    const plan = await resolveActions(planned, staticResolver({}));
    const provider = new DockerProvider();
    let logText = "";
    const store = {
      setSandbox: async () => {},
      setExec: async () => {},
      resetOutput: async () => {},
      appendLog: async () => {},
      recordStep: async () => {},
      finishJob: async () => {},
    } as unknown as RunStore;
    const PLACEHOLDER = "longshore-token-is-added-by-the-proxy";

    const runner = withSecretsProxy(
      async (ctx) => {
        // What createActRunner does once the job is planned and its token minted.
        ctx.proxy?.setGithubToken(TOKEN);
        const out = await executeJob(
          {
            provider,
            store,
            image: IMAGE,
            repoTarball,
            out: (t) => {
              logText += t;
            },
            registry: ctx.redact ?? new SecretRegistry(),
            signal: ctx.signal,
            timeoutSeconds: 300,
            ...(ctx.proxy ? { proxy: ctx.proxy, githubToken: PLACEHOLDER } : {}),
          },
          { runId: a.runId, jobId: a.jobId, attemptId: a.attemptId },
          plan,
        );
        return { state: out.state === "success" ? "success" : "failure", reason: out.reason };
      },
      {
        proxy,
        github: async () => ({ owner: "acme", repo: "app", installationId: "1" }),
      },
    );
    const outcome = await runner({
      run: (await getRun(db, a.scope, a.runId))!,
      job: (await getJob(db, a.scope, a.jobId))!,
      attempt: (await getAttempt(db, a.scope, a.attemptId))!,
      scope: a.scope,
      provider,
      signal: new AbortController().signal,
      store: {} as AttemptContext["store"],
    });
    if (outcome.state !== "success") console.log(outcome, "\n" + logText);
    expect(outcome.state).toBe("success");
    // The job, and act's `secrets.GITHUB_TOKEN` (the -s GITHUB_TOKEN path), hold only the placeholder.
    // (act masks a secret value in the log, so the value shows as ***; the length tells them apart.)
    expect(logText).toContain(`env-token-length=${PLACEHOLDER.length}`);
    expect(logText).toContain(`secrets-token-length=${PLACEHOLDER.length}`);
    expect(logText).not.toContain(`env-token-length=${TOKEN.length}`);
    expect(logText).not.toContain(TOKEN);
    // The repository's own API got the real token from the proxy; another repository got nothing.
    expect(logText).toContain("own-repo-status=200");
    expect(upstreamSaw).toHaveLength(1);
    expect(upstreamSaw[0]?.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(logText).toContain("other-repo-status=403");
    expect(proxy.active).toBe(0);
  }, 600_000);
});
