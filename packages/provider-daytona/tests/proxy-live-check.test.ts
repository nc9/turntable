// The live proxy check is run by hand against a real account, so what can be tested without one
// is tested here: its flags, the sandbox it would create, and that a dry run touches nothing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BAD_CREDENTIAL_CHECK,
  INJECTED_CHECK,
  parseOptions,
  RELAY,
  specFor,
} from "../scripts/proxy-live-check";

const GOOD = [
  "--proxy-host",
  "proxy.example.com",
  "--proxy-port",
  "8443",
  "--tls-name",
  "proxy.example.com",
  "--addresses",
  "203.0.113.10,203.0.113.11",
];

describe("flags", () => {
  test("a complete set parses", () => {
    const o = parseOptions(GOOD);
    expect(o).toMatchObject({
      host: "proxy.example.com",
      port: 8443,
      tlsName: "proxy.example.com",
      addresses: ["203.0.113.10", "203.0.113.11"],
      confine: "address",
      dryRun: false,
    });
  });

  test.each([
    [["--proxy-port", "8443", "--addresses", "203.0.113.10"], "--proxy-host"],
    [["--proxy-host", "p.example.com", "--addresses", "203.0.113.10"], "--proxy-port"],
    [
      ["--proxy-host", "p.example.com", "--proxy-port", "0", "--addresses", "1.2.3.4"],
      "--proxy-port",
    ],
    [
      ["--proxy-host", "p.example.com", "--proxy-port", "99999", "--addresses", "1.2.3.4"],
      "--proxy-port",
    ],
    [["--proxy-host", "p.example.com", "--proxy-port", "443", "--addresses", "not-an-ip"], "IPv4"],
    [["--proxy-host", "p.example.com", "--proxy-port", "443", "--addresses", "999.1.1.1"], "IPv4"],
    [["--proxy-host", "p.example.com", "--proxy-port", "443"], "--addresses"],
    [
      [
        "--proxy-host",
        "p.example.com",
        "--proxy-port",
        "443",
        "--tls-name",
        "10.0.0.1",
        "--addresses",
        "1.2.3.4",
      ],
      "--tls-name",
    ],
    [[...GOOD, "--confine", "other"], "--confine"],
    [[...GOOD, "--upstream", "http://echo.example.com/"], "https"],
    [
      [...GOOD, "--upstream", "https://user:pw@echo.example.com/", "--credential-file", "c.json"],
      "credentials",
    ],
    [[...GOOD, "--credential-file", "c.json"], "--upstream"],
    [[...GOOD, "--upstream", "https://echo.example.com/"], "--credential-file"],
    [[...GOOD, "--expect", "marker"], "--upstream"],
    [[...GOOD, "--surprise"], ""],
  ])("refused before anything is created: %j", (argv, why) => {
    expect(() => parseOptions(argv as string[])).toThrow(why);
  });

  test("a domain-list run needs no addresses", () => {
    const o = parseOptions([
      "--proxy-host",
      "p.example.com",
      "--proxy-port",
      "443",
      "--confine",
      "domain",
    ]);
    expect(o.confine).toBe("domain");
    expect(specFor(o).network.egress).toBe("proxy-domain-filtered");
  });

  test("a full live run's flags, with a credential file and a marker", () => {
    const o = parseOptions([
      ...GOOD,
      "--credential-file",
      "cred.json",
      "--upstream",
      "https://echo.example.com/headers",
      "--expect",
      "auth-ok",
    ]);
    expect(o.upstream?.href).toBe("https://echo.example.com/headers");
    expect(o.expect).toBe("auth-ok");
  });
});

describe("what runs inside the sandbox", () => {
  test("the proxy credential is read from a file, never written into a command", () => {
    const script = INJECTED_CHECK("https://echo.example.com/headers", "auth-ok");
    expect(script).toContain("$(cat /tmp/longshore-proxy/auth)");
    expect(script).toContain("--cacert /tmp/longshore-proxy/ca.pem");
    expect(script).toContain(RELAY);
    expect(script).not.toMatch(/password|secret|token/i);
    expect(script).toContain("rm -f /tmp/longshore-proxy/body");
  });

  test("the marker is matched as a fixed string, quote-safe, and the body is never printed", () => {
    const script = INJECTED_CHECK("https://echo.example.com/", "it's ok; rm -rf /");
    expect(script).toContain("grep -qF --");
    expect(script).toContain("'it'\\''s ok; rm -rf /'");
    expect(script).not.toMatch(/cat \/tmp\/longshore-proxy\/body/);
    expect(INJECTED_CHECK("https://e.example.com/", undefined)).not.toContain("grep");
  });

  test("the bad-credential check asks for the CONNECT status, through the relay", () => {
    expect(BAD_CREDENTIAL_CHECK).toContain("%{http_connect}");
    expect(BAD_CREDENTIAL_CHECK).toContain(`-x ${RELAY}`);
    expect(BAD_CREDENTIAL_CHECK).toContain("bad:bad");
  });
});

describe("the sandbox it would create", () => {
  test("deny-all-except-proxy to the given endpoint, with its addresses", () => {
    const s = specFor(parseOptions(GOOD));
    expect(s.network).toEqual({
      egress: "deny-all-except-proxy",
      proxy: {
        host: "proxy.example.com",
        port: 8443,
        tlsName: "proxy.example.com",
        addresses: ["203.0.113.10", "203.0.113.11"],
      },
    });
    expect(s.ttlSeconds).toBeLessThanOrEqual(30 * 60);
    expect(s).not.toHaveProperty("snapshot");
  });
});

describe("dry run", () => {
  const run = async (args: string[]) => {
    // An empty HOME: a dry run must not need ~/.secrets, so it cannot be reading the key.
    const home = mkdtempSync(join(tmpdir(), "ls-dry-"));
    try {
      const p = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "../scripts/proxy-live-check.ts"), ...args],
        { env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { out, err, code };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test("prints the create body and the planned checks, and needs no key", async () => {
    const r = await run([...GOOD, "--dry-run"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as {
      mode: string;
      createBody: Record<string, unknown>;
      mustNotReach: string[];
      checks: string[];
    };
    expect(j.mode).toBe("dry-run");
    expect(j.createBody).toMatchObject({
      name: "longshore-dev-proxy-live-check",
      labels: { "longshore-dev": "1" },
      networkAllowList: "203.0.113.10/32,203.0.113.11/32",
      public: false,
    });
    expect(j.createBody).not.toHaveProperty("snapshot");
    expect(j.createBody).not.toHaveProperty("networkBlockAll");
    expect(j.mustNotReach).toContain("169.254.169.254:80");
    expect(j.mustNotReach).toContain("8.8.8.8:8443");
    expect(j.checks.join("\n")).toContain("407");
    expect(r.out + r.err).not.toMatch(/authorization|bearer|api[_-]?key/i);
  });

  test("with an upstream it plans the injected request; a domain-list run sends a domain list", async () => {
    const withUp = await run([
      ...GOOD,
      "--credential-file",
      "x.json",
      "--upstream",
      "https://echo.example.com/headers",
      "--dry-run",
    ]);
    expect(JSON.parse(withUp.out).checks.join("\n")).toContain("https://echo.example.com/headers");
    const domain = await run([
      "--proxy-host",
      "proxy.example.com",
      "--proxy-port",
      "443",
      "--confine",
      "domain",
      "--dry-run",
    ]);
    expect(domain.code).toBe(0);
    expect(JSON.parse(domain.out).createBody).toMatchObject({
      domainAllowList: "proxy.example.com",
    });
  });

  test("bad flags exit 2 without creating anything", async () => {
    const r = await run(["--proxy-host", "proxy.example.com", "--proxy-port", "x", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--proxy-port");
  });
});
