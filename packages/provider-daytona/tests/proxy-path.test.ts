import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfraError, SpecError, type SandboxSpec } from "@turntable/provider-sdk";
import {
  DaytonaProvider,
  type DaytonaProviderOptions,
  mustNotReachFor,
  networkSettingFor,
} from "../src/index";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

let mock: ReturnType<typeof startMock>;
beforeEach(() => {
  mock = startMock();
});
afterEach(async () => {
  await mock.stop();
});

const tmp = mkdtempSync(join(tmpdir(), "tt-daytona-proxy-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A throwaway certificate for the proxy endpoint's name, made at run time.
const NAME = "proxy.example.test";
async function cert(name: string): Promise<{ key: string; cert: string }> {
  const dir = mkdtempSync(join(tmp, "c-"));
  const p = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await p.exited) !== 0) throw new Error("openssl failed");
  return {
    key: readFileSync(join(dir, "k.pem"), "utf8"),
    cert: readFileSync(join(dir, "c.pem"), "utf8"),
  };
}

const make = (o: Partial<DaytonaProviderOptions> = {}) =>
  new DaytonaProvider({
    apiKey: () => MOCK_KEY,
    baseUrl: mock.url,
    pollMs: 5,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    ...o,
  });

const spec = (proxy: NonNullable<SandboxSpec["network"]["proxy"]>): SandboxSpec => ({
  name: "job-1",
  labels: { "turntable-run": "run-42" },
  ttlSeconds: 600,
  network: { egress: "deny-all-except-proxy", proxy },
});

const created = (): Record<string, unknown> =>
  mock.requests.filter((r) => r.method === "POST" && r.path === "/api/sandbox").at(-1)!
    .body as Record<string, unknown>;

describe("how the sandbox is confined to the proxy endpoint", () => {
  test("stable addresses: an allow list of exactly those, set in the create call, no block-all", async () => {
    const p = make({ relayInterpreter: process.execPath, relayPort: 0 });
    // The relay cannot start against a closed port, but the create body is what is checked here.
    await p
      .create(spec({ host: NAME, port: 8443, addresses: ["203.0.113.5", "203.0.113.6"] }))
      .catch(() => {});
    const body = created();
    expect(body.networkAllowList).toBe("203.0.113.5/32,203.0.113.6/32");
    expect(body.domainAllowList).toBeUndefined();
    expect(body.networkBlockAll).toBeUndefined();
  });

  test("no stable address, and only with the operator's opt-in: a domain list of the one name", async () => {
    const p = make({ relayInterpreter: process.execPath, allowDomainListConfinement: true });
    await p
      .create({
        ...spec({ host: "origin.example.test", port: 443 }),
        network: {
          egress: "proxy-domain-filtered",
          proxy: { host: "origin.example.test", port: 443, tlsName: "Proxy.Example.Test" },
        },
      })
      .catch(() => {});
    const body = created();
    expect(body.domainAllowList).toBe("proxy.example.test");
    expect(body.networkAllowList).toBeUndefined();
    expect(body.networkBlockAll).toBeUndefined();
  });

  test("deny-all-except-proxy needs the endpoint's addresses; a domain list is never silently substituted", () => {
    const p = make({ allowDomainListConfinement: true });
    expect(() => p.buildCreateBody(spec({ host: NAME, port: 443 }))).toThrow(SpecError);
    expect(() => p.buildCreateBody(spec({ host: NAME, port: 443 }))).toThrow(
      /stable IPv4 addresses/,
    );
    expect(mock.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("the domain-filtered policy is refused unless the operator opted in, and then it is a different policy", () => {
    const domainSpec: SandboxSpec = {
      ...spec({ host: NAME, port: 443 }),
      network: { egress: "proxy-domain-filtered", proxy: { host: NAME, port: 443 } },
    };
    const off = make();
    expect(() => off.buildCreateBody(domainSpec)).toThrow(/allowDomainListConfinement/);
    expect(off.info.network.egressPolicy).not.toContain("proxy-domain-filtered");
    const on = make({ allowDomainListConfinement: true });
    expect(on.buildCreateBody(domainSpec).domainAllowList).toBe(NAME);
    expect(on.info.network.egressPolicy).toContain("proxy-domain-filtered");
    // Still the strict one is the only thing called deny-all-except-proxy.
    expect(on.info.network.egressPolicy).toContain("deny-all-except-proxy");
  });

  test("egress none and open are unchanged", async () => {
    const p = make();
    const none = p.buildCreateBody({
      ...spec({ host: NAME, port: 1 }),
      network: { egress: "none" },
    });
    expect(none.networkBlockAll).toBe(true);
    const open = p.buildCreateBody({
      ...spec({ host: NAME, port: 1 }),
      network: { egress: "open" },
    });
    expect(open.networkBlockAll).toBe(false);
  });

  test("a malformed endpoint is refused before any request", () => {
    const p = make();
    const bad: Parameters<typeof spec>[0][] = [
      { host: NAME, port: 443, addresses: ["not-an-ip"] },
      { host: NAME, port: 443, addresses: ["2001:db8::1"] },
      { host: NAME, port: 443, addresses: ["256.1.1.1"] },
      {
        host: NAME,
        port: 443,
        addresses: Array.from({ length: 11 }, (_, i) => `203.0.113.${i + 1}`),
      },
    ];
    for (const proxy of bad) expect(() => p.buildCreateBody(spec(proxy))).toThrow(SpecError);
    expect(() =>
      p.buildCreateBody({
        ...spec({ host: NAME, port: 1 }),
        network: { egress: "deny-all-except-proxy" },
      }),
    ).toThrow(SpecError);
    expect(mock.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("the provider declares the policy", () => {
    const info = make().info;
    expect(info.network.egressPolicy).toContain("deny-all-except-proxy");
    expect(info.network.proxyReachability).toBe(true);
  });

  test("networkSettingFor", () => {
    expect(networkSettingFor({ host: "x.example.test", addresses: ["198.51.100.1"] })).toEqual({
      networkAllowList: "198.51.100.1/32",
    });
    expect(networkSettingFor({ host: "x.example.test" }, "domain")).toEqual({
      domainAllowList: "x.example.test",
    });
    expect(() => networkSettingFor({ host: "x.example.test" })).toThrow();
    for (const host of ["203.0.113.5", "a b", "localhost", "123.456"]) {
      expect(() => networkSettingFor({ host }, "domain")).toThrow();
    }
  });
});

describe("what must not be reachable", () => {
  test("a public address on the proxy's port, private ranges and metadata; never the gateway; never a listed address", () => {
    const t = mustNotReachFor(8443, undefined);
    expect(t).toContain("8.8.8.8:8443");
    expect(t).toContain("10.0.0.1:80");
    expect(t).toContain("192.168.0.1:80");
    expect(t).toContain("169.254.169.254:80");
    expect(t.some((x) => x.startsWith("172.20.0.1"))).toBe(false);
    // If the endpoint IS 8.8.8.8, another public address stands in.
    const t2 = mustNotReachFor(8443, ["8.8.8.8"]);
    expect(t2.some((x) => x.startsWith("8.8.8.8"))).toBe(false);
    expect(t2).toContain("9.9.9.9:8443");
  });
});

describe("an account that does not apply the list", () => {
  test("is refused: the sandbox is deleted and nothing runs on it", async () => {
    await mock.stop();
    mock = startMock({ ignoreNetworkLists: true });
    const p = make({ relayInterpreter: process.execPath });
    const err = (await p
      .create(spec({ host: NAME, port: 443, addresses: ["203.0.113.5"] }))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("did not apply the network allow list");
    expect(mock.sandboxes.size).toBe(0);
    // No exec ran: the relay was never started.
    expect(mock.requests.filter((r) => r.path.includes("/process/execute")).length).toBe(0);
  });
});

describe("the relay in the sandbox", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A TLS endpoint that answers `pong:<bytes>`, standing in for the proxy's public listener. */
  async function endpoint(name: string): Promise<{ port: number; ca: string }> {
    const c = await cert(name);
    const seen: string[] = [];
    server = createServer({ key: c.key, cert: c.cert }, (s) => {
      s.on("data", (d) => {
        seen.push(d.toString());
        s.write(`pong:${d}`);
      });
      s.on("error", () => {});
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return { port: (server.address() as { port: number }).port, ca: c.cert };
  }

  /** What a tool in the sandbox would do: a plain TCP connection to the relay's local port. */
  const client = (port: number): string[] => [
    process.execPath,
    "-e",
    `const net=require("net");const s=net.connect(${port},"127.0.0.1");let out="";s.on("data",d=>out+=d);s.on("close",()=>{console.log("got="+out);process.exit(0)});s.on("error",()=>{console.log("got=");process.exit(0)});s.write("ping");setTimeout(()=>{console.log("got="+out);process.exit(0)},1500);`,
  ];

  async function run(p: DaytonaProvider, id: string, argv: string[]): Promise<string> {
    const { execId } = await p.exec.start(id, { argv, timeoutSeconds: 20 });
    for (;;) {
      const st = await p.exec.status(id, execId);
      if (st.state !== "running") break;
      await Bun.sleep(50);
    }
    const logs = await p.exec.logs(id, execId, { fromOffset: 0, maxBytes: 4096 });
    return new TextDecoder().decode(logs.bytes);
  }

  test("carries a plain local connection over TLS to the endpoint, which it verifies by name", async () => {
    const ep = await endpoint(NAME);
    const relayPort = 39000 + Math.floor(Math.random() * 500);
    const p = make({ relayInterpreter: process.execPath, relayPort, proxyTlsCaPem: ep.ca });
    const h = await p.create(spec({ host: NAME, port: ep.port, addresses: ["127.0.0.1"] }));
    try {
      expect(h.proxy).toEqual({ host: "127.0.0.1", port: relayPort });
      expect(h.mustNotReach?.length).toBeGreaterThan(3);
      expect(await run(p, h.id, client(relayPort))).toContain("got=pong:ping");
    } finally {
      await p.destroy(h.id);
    }
  }, 30_000);

  test("an endpoint whose certificate is for another name carries nothing", async () => {
    const ep = await endpoint("someone-else.example.test");
    const relayPort = 39500 + Math.floor(Math.random() * 500);
    const p = make({ relayInterpreter: process.execPath, relayPort, proxyTlsCaPem: ep.ca });
    const h = await p.create(spec({ host: NAME, port: ep.port, addresses: ["127.0.0.1"] }));
    try {
      const out = await run(p, h.id, client(relayPort));
      expect(out).toContain("got=");
      expect(out).not.toContain("pong");
    } finally {
      await p.destroy(h.id);
    }
  }, 30_000);

  test("a sandbox whose relay cannot start is deleted and the create fails", async () => {
    const p = make({ relayInterpreter: "/nonexistent/node" });
    const err = (await p
      .create(spec({ host: NAME, port: 443, addresses: ["203.0.113.5"] }))
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("relay");
    expect(mock.sandboxes.size).toBe(0);
  }, 30_000);
});
