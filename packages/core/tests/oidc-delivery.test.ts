import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { wantsIdToken } from "@longshore/act-runner";
import { eq } from "drizzle-orm";
import { type Db } from "../src/db";
import { getAttempt, getJob, getRun } from "../src/db/repos";
import * as s from "../src/db/schema";
import { oidcRule, SecretsProxy, withSecretsProxy } from "../src/proxy";
import { mintAttemptCredential, verifyAttemptCredential } from "../src/oidc/attempt-credential";
import { PROXIED_TOKEN_PLACEHOLDER } from "../src/scheduler/act-runner";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

// Built at run time: a literal in this shape trips secret scanners.
const MASTER = randomBytes(32);
const MINT = "https://ci.example.test/oidc/acme/token";
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
    oidcCredential: (who) => mintAttemptCredential(MASTER, who, Date.now(), 120_000),
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

const allowed = async (_c: AttemptContext, k: string) =>
  k === "protected" || k === "release" ? MINT : undefined;
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

async function planned(idToken: boolean): Promise<void> {
  await db.orm
    .update(s.jobs)
    .set({
      planned: JSON.stringify({ id: "build", key: "build", ...(idToken ? { idToken: true } : {}) }),
    })
    .where(eq(s.jobs.id, a.jobId));
}

describe("OIDC delivery through the proxy", () => {
  test("a job that asked gets the URL and one rule; the real credential is attached, the job's header replaced", async () => {
    await klass("protected");
    await planned(true);
    await withSecretsProxy(
      async (c) => {
        expect(c.proxy?.oidcUrl).toBe(`${MINT}?api-version=2.0`);
        const r = await through(c.proxy!, "ci.example.test", "/oidc/acme/token?audience=sts");
        expect(r.status).toBe(200);
        const auth = upstreamSaw[0]?.headers.get("authorization") ?? "";
        const bearer = /^Bearer (\S+)$/.exec(auth)?.[1] ?? "";
        // The credential the control plane accepts, for this attempt and org, and not the job's own.
        expect(verifyAttemptCredential(MASTER, bearer, Date.now())).toEqual({
          orgId: a.orgId,
          attemptId: a.attemptId,
        });
        expect(bearer).not.toBe("the-job-made-this-up");
        expect(bearer).not.toBe(PROXIED_TOKEN_PLACEHOLDER);
        // The echo of the header is scrubbed on the way back: the job never sees the credential.
        expect(r.body).not.toContain(bearer);
        return done;
      },
      { proxy, oidcMintUrl: allowed },
    )(await ctxOf());
    expect(proxy.active).toBe(0);
  });

  test("nothing else of the instance is reachable: other paths, other orgs' mint paths, a sub path", async () => {
    await klass("release");
    await planned(true);
    await withSecretsProxy(
      async (c) => {
        for (const path of [
          "/api/v1/runs",
          "/oidc/other/token",
          "/oidc/acme/token/extra",
          "/oidc/acme/jwks.json",
        ]) {
          expect((await through(c.proxy!, "ci.example.test", path)).status).toBe(403);
        }
        expect((await through(c.proxy!, "other.example.test", "/oidc/acme/token")).status).toBe(
          403,
        );
        return done;
      },
      { proxy, oidcMintUrl: allowed },
    )(await ctxOf());
    expect(upstreamSaw).toHaveLength(0);
  });

  test("a job that did not ask for id-token: write changes nothing", async () => {
    await klass("protected");
    await planned(false);
    let seen: AttemptContext | undefined;
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy, oidcMintUrl: allowed })(
      await ctxOf(),
    );
    expect(seen?.proxy).toBeUndefined();
  });

  test("untrusted and trusted pull requests get no rule, even when they asked", async () => {
    for (const k of ["untrusted_pr", "trusted_pr"]) {
      await klass(k);
      await planned(true);
      let seen: AttemptContext | undefined;
      await withSecretsProxy(async (c) => ((seen = c), done), { proxy, oidcMintUrl: allowed })(
        await ctxOf(),
      );
      expect(seen?.proxy).toBeUndefined();
    }
  });

  test("an instance with no issuer, or a non-https or odd mint URL, gives no rule", async () => {
    await klass("protected");
    await planned(true);
    let seen: AttemptContext | undefined;
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy })(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
    for (const bad of ["http://ci.example.test/t", "https://ci.example.test/t?x=1", "nonsense"]) {
      expect(oidcRule(bad)).toBeUndefined();
    }
    expect(oidcRule(MINT)).toMatchObject({ host: "ci.example.test", pathExact: true });
  });

  test("a proxy started without an issuer refuses the rule's secret instead of sending nothing", async () => {
    await klass("protected");
    await planned(true);
    const bare = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      upstream: async () => new Response("no"),
      tunnel: async () => {
        throw new Error("no passthrough");
      },
    });
    let status = 0;
    await withSecretsProxy(
      async (c) => {
        const raw = c.proxy!;
        // Same rule, but this proxy cannot make a credential: the request is refused.
        status = await (async () => {
          const prev = proxy;
          proxy = bare;
          try {
            return (await through(raw, "ci.example.test", "/oidc/acme/token")).status;
          } finally {
            proxy = prev;
          }
        })();
        return done;
      },
      { proxy: bare, oidcMintUrl: allowed },
    )(await ctxOf());
    await bare.stop();
    expect(status).not.toBe(200);
  });
});

describe("what the workflow asks for", () => {
  const wf = (perm: string, job = "") =>
    `${perm}jobs:\n  build:\n    runs-on: x\n${job}    steps: []\n`;
  test("id-token: write, at job or workflow level, or write-all; nothing else", async () => {
    const { parse } = await import("yaml");
    const ask = (y: string) => {
      const d = parse(y) as { jobs: { build: unknown } };
      return wantsIdToken(d, d.jobs.build);
    };
    expect(ask(wf("permissions:\n  id-token: write\n"))).toBe(true);
    expect(ask(wf("", "    permissions:\n      id-token: write\n"))).toBe(true);
    expect(ask(wf("permissions: write-all\n"))).toBe(true);
    expect(ask(wf("permissions:\n  id-token: read\n"))).toBe(false);
    expect(ask(wf("permissions:\n  contents: write\n"))).toBe(false);
    expect(ask(wf(""))).toBe(false);
    // A job's own block replaces the workflow's.
    expect(
      ask(wf("permissions:\n  id-token: write\n", "    permissions:\n      contents: read\n")),
    ).toBe(false);
  });
});
