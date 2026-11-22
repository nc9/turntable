import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { type Db } from "../src/db";
import { getAttempt, getJob, getRun, listAudit } from "../src/db/repos";
import * as s from "../src/db/schema";
import { githubRules, githubTargetOf, SecretsProxy, withSecretsProxy } from "../src/proxy";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

// Built at run time: a literal in this shape trips secret scanners.
const TOKEN = ["ghs", "job", "token", "value", "71c2e9a4"].join("_");
let db: Db;
let a: Tenant;
let vault: SecretVault;
let proxy: SecretsProxy;
let upstreamSaw: { url: string; headers: Headers }[] = [];

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  vault = new SecretVault({ db, masterKey: randomBytes(32) });
  upstreamSaw = [];
  proxy = await SecretsProxy.start({
    db,
    vault,
    bindHost: "127.0.0.1",
    upstream: async (u, init) => {
      upstreamSaw.push({ url: String(u), headers: new Headers(init?.headers) });
      return new Response(`you sent ${new Headers(init?.headers).get("authorization")}`);
    },
    tunnel: async () => {
      throw new Error("no passthrough");
    },
  });
});
afterEach(async () => {
  await proxy.stop();
});

async function klass(k: string): Promise<void> {
  await db.orm
    .update(s.runs)
    .set({ trust: JSON.stringify({ class: k, workflowHash: "h" }), repo: "acme/app" })
    .where(eq(s.runs.id, a.runId));
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: k })
    .where(eq(s.jobAttempts.id, a.attemptId));
}

async function ctxOf(extra: Partial<AttemptContext> = {}): Promise<AttemptContext> {
  return {
    run: (await getRun(db, a.scope, a.runId))!,
    job: (await getJob(db, a.scope, a.jobId))!,
    attempt: (await getAttempt(db, a.scope, a.attemptId))!,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
    ...extra,
  };
}

const target = async () => ({ owner: "acme", repo: "app", installationId: "100" });
const done: AttemptOutcome = { state: "success", reason: "ok" };

/** One HTTPS request through the proxy, as a step would make it. */
async function through(
  c: NonNullable<AttemptContext["proxy"]>,
  host: string,
  path: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  const raw = net.connect(proxy.port, proxy.host);
  await new Promise<void>((r, j) => {
    raw.once("connect", () => r());
    raw.once("error", j);
  });
  const basic = Buffer.from(`${c.credential.username}:${c.credential.password}`).toString("base64");
  raw.write(
    `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
  );
  const head = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
  if (!head.startsWith("HTTP/1.1 200")) {
    raw.destroy();
    return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]), body: "" };
  }
  const secure = tls.connect({ socket: raw, servername: host, ca: c.credential.caPem });
  await new Promise<void>((r) => secure.once("secureConnect", () => r()));
  // A job's own Authorization header must be replaced, never added to.
  secure.write(
    `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer the-job-made-this-up\r\nConnection: close\r\n\r\n`,
  );
  const chunks: Buffer[] = [];
  for await (const d of secure) chunks.push(d as Buffer);
  const text = Buffer.concat(chunks).toString();
  return {
    status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]),
    body: text.split("\r\n\r\n")[1] ?? "",
  };
}

describe("githubRules", () => {
  test("the API for one repository, GraphQL, and git over HTTPS for that repository only", () => {
    const rules = githubRules({ owner: "acme", repo: "app", installationId: "1" });
    expect(rules.map((r) => `${r.host}${r.pathPrefix}`)).toEqual([
      "api.github.com/repos/acme/app",
      "api.github.com/graphql",
      "github.com/acme/app",
      "github.com/acme/app.git",
    ]);
    for (const r of rules) expect(r.secret).toBe("@github-token");
  });

  test("an owner or repo that is not a plain name yields no rules", () => {
    for (const bad of [
      { owner: "a/b", repo: "x" },
      { owner: "acme", repo: "../x" },
      { owner: "", repo: "x" },
    ]) {
      expect(githubRules({ ...bad, installationId: "1" })).toEqual([]);
    }
  });
});

describe("the job token behind the proxy", () => {
  test("an untrusted PR gets the GitHub rules and nothing from the vault", async () => {
    await klass("untrusted_pr");
    await vault.set(
      a.orgId,
      "t",
      { name: "NPM_TOKEN", projectId: a.projectId },
      "npm-secret-value-1",
      {
        destinations: ["registry.example.test"],
      },
    );
    const { setProxyRule } = await import("../src/db/repos");
    await setProxyRule(db, a.scope, "t", {
      name: "npm",
      secret: "NPM_TOKEN",
      host: "registry.example.test",
      port: 443,
      methods: ["GET"],
      pathPrefix: "/",
      inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
    });
    let seen: AttemptContext | undefined;
    let registry: string[] = [];
    await withSecretsProxy(
      async (c) => {
        seen = c;
        c.proxy!.setGithubToken(TOKEN);
        // The GitHub token works; the vault's host has no rule for this job.
        expect((await through(c.proxy!, "api.github.com", "/repos/acme/app/issues")).status).toBe(
          200,
        );
        registry = [(await through(c.proxy!, "registry.example.test", "/x")).status.toString()];
        return done;
      },
      { proxy, github: target },
    )(await ctxOf());
    expect(seen?.proxy).toBeDefined();
    expect(registry).toEqual(["403"]);
    expect(upstreamSaw.map((x) => new URL(x.url).host)).toEqual(["api.github.com"]);
    expect(proxy.active).toBe(0);
  });

  test("the token is attached to the repository's API and nothing else; the job's own header is replaced", async () => {
    await klass("protected");
    await withSecretsProxy(
      async (c) => {
        c.proxy!.setGithubToken(TOKEN);
        const ok = await through(c.proxy!, "api.github.com", "/repos/acme/app/pulls/3");
        expect(ok.status).toBe(200);
        expect(upstreamSaw[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        // The echo of the header is scrubbed on the way back.
        expect(ok.body).not.toContain(TOKEN);
        // Another repository, and the rest of the API, get nothing.
        for (const path of ["/repos/acme/other/issues", "/user", "/orgs/acme/repos"]) {
          expect((await through(c.proxy!, "api.github.com", path)).status).toBe(403);
        }
        expect((await through(c.proxy!, "github.com", "/acme/other.git/info/refs")).status).toBe(
          403,
        );
        return done;
      },
      { proxy, github: target },
    )(await ctxOf());
    expect(upstreamSaw).toHaveLength(1);
  });

  test("before a token is set, a request is refused rather than sent without one", async () => {
    await klass("protected");
    let status = 0;
    await withSecretsProxy(
      async (c) => {
        status = (await through(c.proxy!, "api.github.com", "/repos/acme/app/issues")).status;
        return done;
      },
      { proxy, github: target },
    )(await ctxOf());
    expect(status).not.toBe(200);
    expect(upstreamSaw).toHaveLength(0);
  });

  test("git over HTTPS gets the token as Basic credentials for that repository", async () => {
    await klass("release");
    await withSecretsProxy(
      async (c) => {
        c.proxy!.setGithubToken(TOKEN);
        expect(
          (await through(c.proxy!, "github.com", "/acme/app.git/info/refs?service=git-upload-pack"))
            .status,
        ).toBe(200);
        const auth = upstreamSaw[0]?.headers.get("authorization") ?? "";
        expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
          `x-access-token:${TOKEN}`,
        );
        return done;
      },
      { proxy, github: target },
    )(await ctxOf());
  });

  test("the proxy audit shows the injection, and the token is not in it", async () => {
    await klass("protected");
    await withSecretsProxy(
      async (c) => {
        c.proxy!.setGithubToken(TOKEN);
        await through(c.proxy!, "api.github.com", "/repos/acme/app/issues");
        return done;
      },
      { proxy, github: target },
    )(await ctxOf());
    const rows = await listAudit(db, a.scope);
    expect(rows.map((r) => r.op)).toContain("proxy_inject");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  test("no binding or installation, or a local run: no GitHub rules, no proxy", async () => {
    await klass("protected");
    let seen: AttemptContext | undefined;
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy, github: githubTargetOf(db) })(
      await ctxOf(),
    );
    expect(seen?.proxy).toBeUndefined();
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy })(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
  });

  test("a re-attached attempt with GitHub rules only carries on without the proxy, so a token it held is simply unusable", async () => {
    await klass("protected");
    let seen: AttemptContext | undefined;
    const out = await withSecretsProxy(async (c) => ((seen = c), done), { proxy, github: target })(
      await ctxOf({ resume: { sandboxId: "sb", execId: "ex" } }),
    );
    expect(out.state).toBe("success");
    expect(seen?.proxy).toBeUndefined();
    expect(proxy.active).toBe(0);
  });
});
