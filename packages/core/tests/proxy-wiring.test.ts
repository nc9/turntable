import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { eq } from "drizzle-orm";
import { type Db } from "../src/db";
import { getAttempt, getJob, getRun, listAudit, setProxyRule } from "../src/db/repos";
import * as s from "../src/db/schema";
import { SecretRegistry } from "@longshore/redact";
import { withEgressPolicy } from "../src/scheduler/egress";
import { setPassthroughHost } from "../src/db/repos";
import { defaultBindHost, SecretsProxy, withSecretsProxy } from "../src/proxy";
import { LogPipe, type JobEnv } from "../src/run/job-exec";
import { SecretVault } from "../src/secrets/vault";
import type { AttemptContext, AttemptOutcome } from "../src/scheduler/types";
import { seedWorld, type Tenant } from "./ops-helpers";

const VALUE = "wiring-secret-value-5d1e";
const HOST = "api.example.test";
let db: Db;
let a: Tenant;
let vault: SecretVault;
let proxy: SecretsProxy;
let upstreamSaw: Headers[] = [];

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  vault = new SecretVault({ db, masterKey: randomBytes(32) });
  upstreamSaw = [];
  proxy = await SecretsProxy.start({
    db,
    vault,
    bindHost: "127.0.0.1",
    upstream: async (_u, init) => {
      upstreamSaw.push(new Headers(init?.headers));
      return new Response(`echo ${VALUE}`);
    },
    tunnel: async () => {
      throw new Error("no passthrough here");
    },
  });
});

afterEach(async () => {
  await proxy.stop();
});

async function seed(klass: string | null, plan: string | null = null): Promise<void> {
  await db.orm
    .update(s.runs)
    .set({ trust: klass ? JSON.stringify({ class: klass, workflowHash: "h" }) : null, plan })
    .where(eq(s.runs.id, a.runId));
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", trustClass: klass })
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
}

async function ctxOf(extra: Partial<AttemptContext> = {}): Promise<AttemptContext> {
  const run = (await getRun(db, a.scope, a.runId))!;
  const job = (await getJob(db, a.scope, a.jobId))!;
  const attempt = (await getAttempt(db, a.scope, a.attemptId))!;
  return {
    run,
    job,
    attempt,
    scope: a.scope,
    provider: {} as AttemptContext["provider"],
    signal: new AbortController().signal,
    store: {} as AttemptContext["store"],
    ...extra,
  };
}

const done: AttemptOutcome = { state: "success", reason: "ok" };

describe("registration around an attempt", () => {
  test("untrusted_pr gets no proxy and registers nothing, whatever rules exist", async () => {
    await seed("untrusted_pr");
    let seen: AttemptContext | undefined;
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy })(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
    expect(seen?.redact).toBeUndefined();
    expect(proxy.active).toBe(0);
  });

  test("a project with no rules runs as before", async () => {
    await seed("protected");
    await db.orm.delete(s.proxyRules);
    let seen: AttemptContext | undefined;
    await withSecretsProxy(async (c) => ((seen = c), done), { proxy })(await ctxOf());
    expect(seen?.proxy).toBeUndefined();
  });

  test("a protected attempt is registered while it runs and revoked after", async () => {
    await seed("protected");
    let during = 0;
    let cred: NonNullable<AttemptContext["proxy"]> | undefined;
    await withSecretsProxy(
      async (c) => {
        during = proxy.active;
        cred = c.proxy;
        return done;
      },
      { proxy },
    )(await ctxOf());
    expect(during).toBe(1);
    expect(cred?.credential.username).toBe(a.attemptId);
    expect(proxy.active).toBe(0);
  });

  test("a throwing runner still revokes", async () => {
    await seed("release");
    await expect(
      withSecretsProxy(
        async () => {
          throw new Error("boom");
        },
        { proxy },
      )(await ctxOf()),
    ).rejects.toThrow("boom");
    expect(proxy.active).toBe(0);
  });

  test("an abort (cancel, timeout, lease loss) revokes at once, before the runner returns", async () => {
    await seed("protected");
    const ac = new AbortController();
    let activeAfterAbort = -1;
    await withSecretsProxy(
      async () => {
        ac.abort("lease lost");
        activeAfterAbort = proxy.active;
        return done;
      },
      { proxy },
    )(await ctxOf({ signal: ac.signal }));
    expect(activeAfterAbort).toBe(0);
  });

  test("a re-attached attempt is refused: its credential died with the old process", async () => {
    await seed("protected");
    let ran = false;
    const out = await withSecretsProxy(async () => ((ran = true), done), { proxy })(
      await ctxOf({ resume: { sandboxId: "sb", execId: "ex" } }),
    );
    expect(ran).toBe(false);
    expect(out.state).toBe("infra_error");
  });

  test("a rule whose host the secret no longer lists is dropped at registration", async () => {
    await seed("protected");
    await vault.set(a.orgId, "t", { name: "NPM_TOKEN", projectId: a.projectId }, VALUE, {
      destinations: ["other.example.test"],
    });
    expect(await proxy.rulesFor(a.scope)).toEqual([]);
  });
});

describe("a request through the proxy", () => {
  test("is injected from the vault, audited, redacted, and the rule is gone after the attempt", async () => {
    await seed("protected");
    let status = 0;
    let body = "";
    let redacted = "";
    let credential: NonNullable<AttemptContext["proxy"]> | undefined;
    await withSecretsProxy(
      async (c) => {
        credential = c.proxy;
        const raw = net.connect(proxy.port, "127.0.0.1");
        await new Promise<void>((r) => raw.once("connect", () => r()));
        const basic = Buffer.from(
          `${c.proxy!.credential.username}:${c.proxy!.credential.password}`,
        ).toString("base64");
        raw.write(
          `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
        );
        await new Promise<void>((r) => raw.once("data", () => r()));
        const secure = tls.connect({
          socket: raw,
          servername: HOST,
          ca: c.proxy!.credential.caPem,
        });
        await new Promise<void>((r) => secure.once("secureConnect", () => r()));
        secure.write(`GET /v1/pkg HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);
        const chunks: Buffer[] = [];
        for await (const d of secure) chunks.push(d as Buffer);
        const text = Buffer.concat(chunks).toString();
        status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]);
        body = text.split("\r\n\r\n")[1] ?? "";
        const { redactString } = await import("@longshore/redact");
        redacted = redactString(`log: ${VALUE}`, c.redact!);
        return done;
      },
      { proxy },
    )(await ctxOf());
    expect(status).toBe(200);
    // The upstream got the credential; the job's copy of the response has it scrubbed.
    expect(upstreamSaw[0]?.get("authorization")).toBe(`Bearer ${VALUE}`);
    expect(body).not.toContain(VALUE);
    // The log redactor learned the value when it was injected.
    expect(redacted).not.toContain(VALUE);
    // The use is in the vault's audit and the proxy's.
    const ops = (await listAudit(db, a.scope)).map((r) => r.op);
    expect(ops).toContain("secret_use");
    expect(ops).toContain("proxy_inject");
    // After the attempt the credential is dead: a new CONNECT is refused.
    const raw = net.connect(proxy.port, "127.0.0.1");
    await new Promise<void>((r) => raw.once("connect", () => r()));
    const basic = Buffer.from(
      `${credential!.credential.username}:${credential!.credential.password}`,
    ).toString("base64");
    raw.write(
      `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`,
    );
    const answer = await new Promise<string>((r) => raw.once("data", (d) => r(d.toString())));
    expect(answer.startsWith("HTTP/1.1 407")).toBe(true);
    raw.destroy();
  });
});

describe("redaction of a value that is first injected mid-job", () => {
  test("a value registered after the log pipe exists is redacted when a later step echoes it, even split across chunks", async () => {
    const registry = new SecretRegistry();
    let shown = "";
    const stored: Buffer[] = [];
    const env = {
      registry,
      out: (t: string) => {
        shown += t;
      },
      store: {
        appendLog: async (_id: string, _at: number, b: Uint8Array) => {
          stored.push(Buffer.from(b));
        },
      },
    } as unknown as JobEnv;
    const pipe = new LogPipe(env, "att");
    pipe.push("step one: nothing secret yet\n");
    // The proxy injects the value for the first time, and the attempt's registry learns it.
    registry.register(VALUE);
    pipe.push(`step two echoes the header: Bearer ${VALUE.slice(0, 9)}`);
    pipe.push(`${VALUE.slice(9)} and its base64 ${Buffer.from(VALUE).toString("base64")}\n`);
    await pipe.close();
    const all = `${shown}\n${Buffer.concat(stored).toString()}`;
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain(VALUE.slice(0, 9) + VALUE.slice(9));
    expect(all).not.toContain(Buffer.from(VALUE).toString("base64"));
    expect(shown).toContain("step one: nothing secret yet");
    expect(shown).toContain("step two echoes the header");
  });
});

describe("where the proxy listens", () => {
  test("the Docker bridge gateway when known, else loopback; never every interface by default", async () => {
    expect(await defaultBindHost(async () => "172.17.0.1")).toBe("172.17.0.1");
    expect(await defaultBindHost(async () => undefined)).toBe("127.0.0.1");
  });

  test("a start with no bind asks for the gateway and listens on loopback when there is none", async () => {
    const logs: string[] = [];
    const p = await SecretsProxy.start({
      db,
      vault,
      bridgeGateway: async () => undefined,
      log: (m) => logs.push(m),
    });
    try {
      // Reachable on loopback, and nothing was warned about.
      const raw = net.connect(p.port, "127.0.0.1");
      await new Promise<void>((r, j) => {
        raw.once("connect", () => r());
        raw.once("error", j);
      });
      raw.destroy();
      expect(logs.join("\n")).not.toContain("WARNING");
    } finally {
      await p.stop();
    }
  });

  test("every interface is an explicit choice and warns", async () => {
    const logs: string[] = [];
    const p = await SecretsProxy.start({
      db,
      vault,
      bindHost: "0.0.0.0",
      log: (m) => logs.push(m),
    });
    await p.stop();
    expect(logs.join("\n")).toContain("WARNING");
    expect(logs.join("\n")).toContain("0.0.0.0");
  });
});

describe("passthrough and secret-bearing egress", () => {
  test("an attempt gets exactly the project's listed hosts, and none when there are none", async () => {
    await seed("protected");
    let hosts: readonly unknown[] | undefined;
    const peek = async (): Promise<readonly unknown[] | undefined> => {
      const out = proxy.register(await ctxOf(), await proxy.rulesFor(a.scope), {
        passthroughHosts: await proxy.passthroughFor(a.scope),
        ttlMs: 60_000,
      });
      hosts = await proxy.passthroughFor(a.scope);
      proxy.release(a.attemptId);
      void out;
      return hosts;
    };
    expect(await peek()).toEqual([]);
    await setPassthroughHost(db, a.scope, "t", "github.com", [443]);
    await setPassthroughHost(db, a.scope, "t", "*.githubusercontent.com", [443, 8443]);
    expect(await peek()).toEqual([
      { host: "*.githubusercontent.com", ports: [443, 8443] },
      { host: "github.com", ports: [443] },
    ]);
  });

  test("a proxied job is secret-bearing: a plan with open egress is refused before it runs", async () => {
    await seed("protected", JSON.stringify({ egress: "open" }));
    let ran = false;
    const guarded = withEgressPolicy(async () => ((ran = true), done), {
      secretBearing: (c) => c.proxy !== undefined,
    });
    const provider = {
      info: {
        name: "docker",
        network: { egressPolicy: ["none", "open", "deny-all-except-proxy"] },
      },
    } as unknown as AttemptContext["provider"];
    const out = await withSecretsProxy(guarded, { proxy })({ ...(await ctxOf()), provider });
    expect(out.state).toBe("infra_error");
    expect(out.reason).toContain("open egress");
    expect(ran).toBe(false);
    expect(proxy.active).toBe(0);
    // The same job with egress none runs.
    await db.orm
      .update(s.runs)
      .set({ plan: JSON.stringify({ egress: "none" }) })
      .where(eq(s.runs.id, a.runId));
    const ok = await withSecretsProxy(guarded, { proxy })({ ...(await ctxOf()), provider });
    expect(ok.state).toBe("success");
  });
});

describe("a public TLS listener for sandboxes in another provider's network", () => {
  test("the endpoint handed to a provider carries its public name, port and addresses", async () => {
    const ca = new (await import("@longshore/proxy")).JobCa({
      label: "t",
      now: Date.now(),
      ttlMs: 60_000,
    });
    const leaf = ca.leafFor("proxy.example.test");
    const p = await SecretsProxy.start({
      db,
      vault,
      bindHost: "127.0.0.1",
      tls: { key: leaf.key, cert: leaf.cert },
      advertiseHost: "proxy.example.test",
      advertisePort: 443,
      advertiseAddresses: ["203.0.113.7"],
    });
    try {
      await seed("protected");
      let listen: unknown;
      await withSecretsProxy(
        async (c) => {
          listen = c.proxy?.listen;
          return done;
        },
        { proxy: p },
      )(await ctxOf());
      expect(listen).toEqual({
        host: "proxy.example.test",
        port: 443,
        tlsName: "proxy.example.test",
        addresses: ["203.0.113.7"],
      });
    } finally {
      await p.stop();
    }
  });

  test("without TLS the endpoint is just host and port, as for Docker", async () => {
    await seed("protected");
    let listen: unknown;
    await withSecretsProxy(
      async (c) => {
        listen = c.proxy?.listen;
        return done;
      },
      { proxy },
    )(await ctxOf());
    expect(Object.keys((listen ?? {}) as object).sort()).toEqual(["host", "port"]);
  });
});
