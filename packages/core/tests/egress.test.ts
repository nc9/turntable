import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import type { Provider } from "@longshore/provider-sdk";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import { CANARY_TARGETS, probeEgress } from "../src/run/egress-canary";
import { executeJob } from "../src/run/job-exec";
import { egressDecision, egressForRun, withEgressPolicy } from "../src/scheduler/egress";
import type { AttemptContext } from "../src/scheduler/types";

const info = (egressPolicy: string[]) =>
  ({ name: "p", network: { egressPolicy, ingress: false, proxyReachability: false } }) as never;

test("egress is none unless the plan says open or allowlist; odd values mean none", () => {
  expect(egressForRun(null)).toBe("none");
  expect(egressForRun("{}")).toBe("none");
  expect(egressForRun('{"egress":"open"}')).toBe("open");
  expect(egressForRun('{"egress":"allowlist"}')).toBe("allowlist");
  for (const odd of ['{"egress":"OPEN"}', '{"egress":"all"}', '{"egress":1}', "nope", "null"]) {
    expect(egressForRun(odd)).toBe("none");
  }
  expect(egressForRun(null, "open")).toBe("open");
});

test("a provider that cannot enforce the requested policy is refused, none included", () => {
  const dockerLike = info(["none", "open"]);
  expect(egressDecision({ egress: "none", secretBearing: true, provider: dockerLike })).toEqual({
    ok: true,
  });
  expect(egressDecision({ egress: "open", secretBearing: false, provider: dockerLike })).toEqual({
    ok: true,
  });
  const noCut = egressDecision({ egress: "none", secretBearing: false, provider: info(["open"]) });
  expect(noCut).toEqual({ ok: false, reason: "egress: provider p cannot enforce egress none" });
  const noAllow = egressDecision({
    egress: "allowlist",
    secretBearing: false,
    provider: dockerLike,
  });
  expect(noAllow).toEqual({
    ok: false,
    reason: "egress: provider p cannot enforce egress allowlist",
  });
  expect(
    egressDecision({
      egress: "allowlist",
      secretBearing: true,
      provider: info(["none", "allowlist"]),
    }),
  ).toEqual({ ok: true });
});

test("a secret-bearing job never runs on open egress, whatever the provider can do", () => {
  expect(
    egressDecision({ egress: "open", secretBearing: true, provider: info(["none", "open"]) }),
  ).toEqual({
    ok: false,
    reason: "egress: a job with secrets cannot run with open egress",
  });
});

test("withEgressPolicy refuses before the runner starts, and passes compliant jobs through", async () => {
  let ran = 0;
  const run = withEgressPolicy(async () => (ran++, { state: "success", reason: "ok" }), {
    secretBearing: (c) => c.job.jobKey === "secret",
  });
  const ctx = (plan: string | null, jobKey: string, egressPolicy: string[]) =>
    ({
      run: { plan },
      job: { jobKey },
      provider: { info: info(egressPolicy) },
    }) as unknown as AttemptContext;
  expect((await run(ctx(null, "a", ["none", "open"]))).state).toBe("success");
  expect(ran).toBe(1);
  expect(await run(ctx(null, "a", ["open"]))).toMatchObject({
    state: "infra_error",
    reason: expect.stringContaining("cannot enforce egress none"),
  });
  expect(await run(ctx('{"egress":"open"}', "secret", ["none", "open"]))).toMatchObject({
    reason: expect.stringContaining("secrets"),
  });
  expect(ran).toBe(1);
});

// ---- the canary, with the real probe script run through a local stand-in for a sandbox ----

const tmp = mkdtempSync(join(tmpdir(), "ls-canary-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A provider whose exec runs the command on this machine; `path` sets what tools exist. */
function localProvider(path: string): Provider {
  const results = new Map<string, { exit: number; out: string }>();
  let n = 0;
  return {
    exec: {
      async start(_id: string, o: { argv: readonly string[] }) {
        const argv = [...o.argv];
        if (argv[0] === "sh") argv[0] = "/bin/sh";
        const p = Bun.spawn(argv, {
          env: { PATH: path },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        const id = `tt1-${String(++n).padStart(24, "0")}`;
        const [out, exit] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        results.set(id, { exit, out });
        return { execId: id };
      },
      async status(_id: string, execId: string) {
        const r = results.get(execId)!;
        return { state: "exited", exitCode: r.exit };
      },
      async logs(_id: string, execId: string) {
        const r = results.get(execId)!;
        const bytes = new TextEncoder().encode(r.out);
        return { bytes, nextOffset: bytes.length, eof: true };
      },
    },
  } as unknown as Provider;
}

const REAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

async function listening(): Promise<{ port: number; close: () => void }> {
  const srv = createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as { port: number }).port, close: () => srv.close() };
}

const hasCurl = Bun.which("curl", { PATH: REAL_PATH }) !== null;

test.skipIf(!hasCurl)(
  "the canary says blocked when nothing answers, and reachable (naming the target) when something does",
  async () => {
    const p = localProvider(REAL_PATH);
    // a port nothing listens on
    const closed = await listening();
    closed.close();
    await Bun.sleep(30);
    expect(await probeEgress(p, "sbx", { targets: [`127.0.0.1:${closed.port}`] })).toEqual({
      kind: "blocked",
    });
    const open = await listening();
    try {
      expect(
        await probeEgress(p, "sbx", {
          targets: [`127.0.0.1:${closed.port}`, `127.0.0.1:${open.port}`],
        }),
      ).toEqual({
        kind: "reachable",
        target: `127.0.0.1:${open.port}`,
      });
    } finally {
      open.close();
    }
  },
);

test("with no curl, wget, nc or bash the canary is unknown, not blocked", async () => {
  const empty = mkdtempSync(join(tmp, "bin-"));
  const v = await probeEgress(localProvider(empty), "sbx", { targets: ["127.0.0.1:9"] });
  expect(v).toMatchObject({ kind: "unknown", why: expect.stringContaining("no curl") });
});

test("the default targets are a public IP and the metadata IP, by address so DNS cannot hide a hole", () => {
  expect(CANARY_TARGETS).toEqual(["1.1.1.1:80", "169.254.169.254:80"]);
});

// ---- the canary inside executeJob ----

function jobEnv(world: FakeWorld, extra: Record<string, unknown>) {
  const events: string[] = [];
  return {
    events,
    env: {
      provider: world.provider(),
      store: {
        setSandbox: async () => {},
        finishJob: async () => {},
        appendLog: async () => {},
        recordStep: async () => {},
      },
      out: (t: string) => void events.push(t),
      registry: undefined as never,
      image: "img",
      repoTarball: new Uint8Array(1),
      egress: "none" as const,
      ...extra,
    },
  };
}

test.skipIf(!hasCurl)(
  "a job whose sandbox can reach out is not run when egress is none",
  async () => {
    const world = new FakeWorld({ hostPaths: [tmp] });
    try {
      const open = await listening();
      const prov = world.provider();
      // route the canary at the local listener by wrapping exec.start
      const orig = prov.exec.start.bind(prov.exec);
      prov.exec.start = (id, o) =>
        orig(id, {
          ...o,
          argv:
            o.argv[0] === "sh" && o.argv[2]?.includes("tool=")
              ? [...o.argv.slice(0, 4), `127.0.0.1:${open.port}`]
              : o.argv,
        });
      const { SecretRegistry } = await import("@longshore/redact");
      const { env } = jobEnv(world, {
        provider: prov,
        canary: true,
        registry: new SecretRegistry(),
      });
      const out = await executeJob(
        env as never,
        { runId: "r", jobId: "j", attemptId: "a" },
        {} as never,
      );
      open.close();
      expect(out.state).toBe("infra_error");
      expect(out.reason).toContain("egress canary: the sandbox reached 127.0.0.1");
      expect(out.reason).toContain("the job was not run");
    } finally {
      world.dispose();
    }
  },
);

test("a secret-bearing job is not run when the canary cannot verify isolation", async () => {
  const world = new FakeWorld({ hostPaths: [tmp] });
  try {
    const prov = world.provider();
    const orig = prov.exec.start.bind(prov.exec);
    // a sandbox image with no test tool: the probe exits 125
    prov.exec.start = (id, o) => orig(id, { ...o, argv: ["sh", "-c", "exit 125"] });
    const { SecretRegistry } = await import("@longshore/redact");
    const { env } = jobEnv(world, {
      provider: prov,
      canary: true,
      secretBearing: true,
      registry: new SecretRegistry(),
    });
    const out = await executeJob(
      env as never,
      { runId: "r", jobId: "j", attemptId: "a" },
      {} as never,
    );
    expect(out.state).toBe("infra_error");
    expect(out.reason).toContain("could not verify isolation");
    expect(out.reason).toContain("a job with secrets was not run");
  } finally {
    world.dispose();
  }
});

// ---- a proxied job fails closed when the provider does not name what must be closed ----

for (const [label, mustNotReach] of [
  ["a missing list", undefined],
  ["an empty list", []],
] as const) {
  test(`a proxied job is not run when the provider returns ${label} of host addresses to verify`, async () => {
    const world = new FakeWorld({ hostPaths: [tmp] });
    try {
      const prov = world.provider() as unknown as {
        info: { network: { egressPolicy: string[] } };
        create: (spec: unknown) => Promise<Record<string, unknown>>;
        exec: Provider["exec"];
      };
      prov.info = {
        ...prov.info,
        network: { ...prov.info.network, egressPolicy: ["none", "deny-all-except-proxy"] },
      };
      const made = prov.create.bind(prov);
      prov.create = async (spec) => ({
        ...(await made(spec)),
        proxy: { host: "10.0.0.2", port: 3128 },
        ...(mustNotReach ? { mustNotReach } : {}),
      });
      // Every probe reports success: the only thing wrong is the missing list.
      const orig = prov.exec.start.bind(prov.exec);
      prov.exec.start = (id, o) => orig(id, { ...o, argv: ["sh", "-c", "exit 0"] });
      const { SecretRegistry } = await import("@longshore/redact");
      const { env } = jobEnv(world, {
        provider: prov,
        registry: new SecretRegistry(),
        proxy: {
          listen: { host: "host.docker.internal", port: 1 },
          credential: {
            username: "u",
            password: "p-not-a-real-credential",
            caPem: "ca",
            expiresAt: 0,
            proxyUrl: () => "http://u:p@10.0.0.2:3128",
          },
        },
      });
      const out = await executeJob(
        env as never,
        { runId: "r", jobId: "j", attemptId: "a" },
        {} as never,
      );
      expect(out.state).toBe("infra_error");
      expect(out.reason).toContain("did not name the host addresses to verify closed");
    } finally {
      world.dispose();
    }
  });
}
