import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { type Db } from "../src/db";
import { getAttempt, getJob, getRun } from "../src/db/repos";
import * as s from "../src/db/schema";
import { verifyAttemptCredential } from "../src/oidc/attempt-credential";
import { JobOidc, OIDC_PLACEHOLDER_TOKEN } from "../src/oidc/job-delivery";
import { createOidcHandler } from "../src/oidc/http";
import { OidcIssuer } from "../src/oidc/issuer";
import { OIDC_CREDENTIAL_SECRET, oidcRules, SecretsProxy, withSecretsProxy } from "../src/proxy";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const BASE = "https://ci.example.test/oidc";
const WF_ASKS =
  "name: t\non: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      id-token: write\n    steps: []\n";
const WF_PLAIN = "name: t\non: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n";
const done: AttemptOutcome = { state: "success", reason: "ok" };

let db: Db;
let a: Tenant;
let master: Buffer;
let issuer: OidcIssuer;
let jobOidc: JobOidc;
let proxy: SecretsProxy;
let upstreamSaw: { url: string; headers: Headers }[] = [];

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  master = randomBytes(32);
  issuer = new OidcIssuer({ db, masterKey: master, baseUrl: BASE });
  jobOidc = new JobOidc({ db, issuer, masterKey: master });
  upstreamSaw = [];
  proxy = await SecretsProxy.start({
    db,
    vault: new SecretVault({ db, masterKey: master }),
    bindHost: "127.0.0.1",
    upstream: async (u, init) => {
      upstreamSaw.push({ url: String(u), headers: new Headers(init?.headers) });
      return new Response("minted");
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
    .set({
      trust: JSON.stringify({ class: k, workflowHash: "h" }),
      repo: "acme/web",
      actor: "octo",
      ref: "refs/heads/main",
      event: "push",
    })
    .where(eq(s.runs.id, a.runId));
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: k })
    .where(eq(s.jobAttempts.id, a.attemptId));
}

async function ctxOf(): Promise<AttemptContext> {
  return {
    run: (await getRun(db, a.scope, a.runId))!,
    job: (await getJob(db, a.scope, a.jobId))!,
    attempt: (await getAttempt(db, a.scope, a.attemptId))!,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
  };
}

const req = (klassName: string, workflowYaml: string) => ({
  orgId: a.orgId,
  attemptId: a.attemptId,
  klass: klassName,
  workflowYaml,
  jobId: "a",
});

/** One HTTPS request through the proxy, as a step would make it. */
async function through(
  c: NonNullable<AttemptContext["proxy"]>,
  host: string,
  path: string,
  method = "GET",
): Promise<number> {
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
    return Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]);
  }
  const secure = tls.connect({ socket: raw, servername: host, ca: c.credential.caPem });
  await new Promise<void>((r) => secure.once("secureConnect", () => r()));
  secure.write(
    `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer the-job-made-this-up\r\nConnection: close\r\n\r\n`,
  );
  const chunks: Buffer[] = [];
  for await (const d of secure) chunks.push(d as Buffer);
  return Number(/^HTTP\/1\.1 (\d+)/.exec(Buffer.concat(chunks).toString())?.[1]);
}

describe("JobOidc.issue", () => {
  test("a protected job that asked gets the variables, with a placeholder as the request token", async () => {
    const r = await jobOidc.issue(req("protected", WF_ASKS));
    if ("none" in r) throw new Error(r.none);
    expect(r.requestUrl).toBe(`${BASE}/${a.slug}/token?api-version=2.0`);
    expect(r.requestToken).toBe(OIDC_PLACEHOLDER_TOKEN);
    // The credential is the real one, for the proxy; it is not what the job is given.
    expect(r.credential).not.toBe(r.requestToken);
    expect(verifyAttemptCredential(master, r.credential, Date.now())).toEqual({
      orgId: a.orgId,
      attemptId: a.attemptId,
    });
    expect(r.mint).toEqual({
      host: "ci.example.test",
      port: 443,
      pathPrefix: `/oidc/${a.slug}/token`,
    });
  });

  test("a job that did not ask gets nothing, whatever its class", async () => {
    expect(await jobOidc.issue(req("protected", WF_PLAIN))).toEqual({
      none: "the job did not ask for it",
    });
  });

  test("an untrusted or trusted pull request gets nothing even when it asked", async () => {
    for (const k of ["untrusted_pr", "trusted_pr"]) {
      const r = await jobOidc.issue(req(k, WF_ASKS));
      expect("none" in r && r.none).toContain("may not mint");
    }
  });

  test("an operator widening the allow list is honoured, and only for what was named", async () => {
    const wide = new JobOidc({
      db,
      issuer: new OidcIssuer({
        db,
        masterKey: master,
        baseUrl: BASE,
        allowClasses: ["protected", "release", "trusted_pr"],
      }),
      masterKey: master,
    });
    expect("none" in (await wide.issue(req("trusted_pr", WF_ASKS)))).toBe(false);
    expect("none" in (await wide.issue(req("untrusted_pr", WF_ASKS)))).toBe(true);
  });

  test("an issuer that is not https is not reachable through the proxy, so nothing is issued", async () => {
    const plain = new JobOidc({
      db,
      issuer: new OidcIssuer({ db, masterKey: master, baseUrl: "http://ci.example.test/oidc" }),
      masterKey: master,
    });
    expect("none" in (await plain.issue(req("protected", WF_ASKS)))).toBe(true);
  });
});

describe("the mint credential behind the proxy", () => {
  const wrap = (inner: (c: AttemptContext) => Promise<AttemptOutcome>) =>
    withSecretsProxy(inner, { proxy, oidc: (c, k) => jobOidc.proxyTarget(c, k) });

  test("the rule is exactly the mint path and names the credential secret", () => {
    const [r] = oidcRules({ host: "ci.example.test", port: 443, pathPrefix: "/oidc/acme/token" });
    expect(r).toMatchObject({
      host: "ci.example.test",
      methods: ["GET", "POST"],
      pathPrefix: "/oidc/acme/token",
      pathExact: true,
      secret: OIDC_CREDENTIAL_SECRET,
    });
  });

  test("the proxy attaches the credential to the mint request and nothing else on that host", async () => {
    await klass("protected");
    const issued = await jobOidc.issue(req("protected", WF_ASKS));
    if ("none" in issued) throw new Error(issued.none);
    await wrap(async (c) => {
      c.proxy!.setOidcCredential(issued.credential);
      expect(
        await through(
          c.proxy!,
          "ci.example.test",
          `/oidc/${a.slug}/token?audience=sts&api-version=2.0`,
        ),
      ).toBe(200);
      // The job's own header is replaced by the credential.
      expect(upstreamSaw[0]?.headers.get("authorization")).toBe(`Bearer ${issued.credential}`);
      // Another org's issuer, the JWKS and anything else on the host get no credential.
      for (const path of ["/oidc/other/token", `/oidc/${a.slug}/jwks.json`, "/api/v1/runs"]) {
        expect(await through(c.proxy!, "ci.example.test", path)).toBe(403);
      }
      return done;
    })(await ctxOf());
    expect(upstreamSaw).toHaveLength(1);
  });

  test("before a credential is set, the request is refused rather than sent without one", async () => {
    await klass("protected");
    let status = 0;
    await wrap(async (c) => {
      status = await through(c.proxy!, "ci.example.test", `/oidc/${a.slug}/token`);
      return done;
    })(await ctxOf());
    expect(status).not.toBe(200);
    expect(upstreamSaw).toHaveLength(0);
  });

  test("a class that may not mint gets no rule at all, so no proxy is registered", async () => {
    await klass("untrusted_pr");
    let seen: AttemptContext | undefined;
    await wrap(async (c) => ((seen = c), done))(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
  });
});

describe("the minted credential works at the issuer", () => {
  test("the endpoint accepts it for its own attempt and org, and returns a token for the audience", async () => {
    await klass("protected");
    const issued = await jobOidc.issue(req("protected", WF_ASKS));
    if ("none" in issued) throw new Error(issued.none);
    const handler = createOidcHandler({ db, issuer, masterKey: master });
    const res = await handler.handle(
      new Request(`${BASE}/${a.slug}/token?audience=sts.example`, {
        headers: { authorization: `Bearer ${issued.credential}` },
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { value: string };
    const claims = JSON.parse(Buffer.from(body.value.split(".")[1]!, "base64url").toString()) as {
      aud: string;
      trust_class: string;
      attempt_id: string;
    };
    expect(claims).toMatchObject({
      aud: "sts.example",
      trust_class: "protected",
      attempt_id: a.attemptId,
    });
  });
});
