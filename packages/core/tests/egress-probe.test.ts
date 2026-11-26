import { describe as group, expect, test } from "bun:test";
import {
  describe,
  egressProbeConfigFromEnv,
  errorCode,
  probeHost,
  resolverConfig,
  startEgressProbe,
} from "../src/egress-probe";

group("egress probe config", () => {
  test("off unless the period is set", () => {
    expect(egressProbeConfigFromEnv({})).toBeUndefined();
  });
  test("defaults to the GitHub web host and the Daytona API, api.github.com by DNS only", () => {
    expect(egressProbeConfigFromEnv({ TURNTABLE_EGRESS_PROBE_SECONDS: "60" })).toEqual({
      periodSeconds: 60,
      hosts: ["github.com", "app.daytona.io"],
      dnsOnly: ["api.github.com"],
    });
  });
  test("never sends a HEAD to api.github.com (the anonymous REST budget)", async () => {
    expect(() =>
      egressProbeConfigFromEnv({
        TURNTABLE_EGRESS_PROBE_SECONDS: "60",
        TURNTABLE_EGRESS_PROBE_HOSTS: "api.github.com",
      }),
    ).toThrow();
    let heads = 0;
    const r = await probeHost(
      "api.github.com",
      {
        resolve: async () => ({}),
        head: async () => {
          heads++;
          return { status: 200 };
        },
      },
      true,
    );
    expect(heads).toBe(0);
    expect(r.headMs).toBeUndefined();
  });
  test("refuses a bad period or a host that is not a plain host name", () => {
    expect(() => egressProbeConfigFromEnv({ TURNTABLE_EGRESS_PROBE_SECONDS: "5" })).toThrow();
    expect(() =>
      egressProbeConfigFromEnv({
        TURNTABLE_EGRESS_PROBE_SECONDS: "60",
        TURNTABLE_EGRESS_PROBE_HOSTS: "https://x.example/path",
      }),
    ).toThrow();
    expect(() =>
      egressProbeConfigFromEnv({
        TURNTABLE_EGRESS_PROBE_SECONDS: "60",
        TURNTABLE_EGRESS_PROBE_HOSTS: "localhost",
      }),
    ).toThrow();
  });
});

group("egress probe", () => {
  test("a DNS failure is reported with its code and no HEAD is sent", async () => {
    let heads = 0;
    const r = await probeHost("api.github.com", {
      resolve: () => Promise.reject(Object.assign(new Error("x"), { code: "EAI_AGAIN" })),
      head: async () => {
        heads++;
        return { status: 200 };
      },
    });
    expect(r.dnsError).toBe("EAI_AGAIN");
    expect(heads).toBe(0);
    expect(describe(r)).toMatchObject({ bad: true });
    expect(describe(r).line).toContain("dns failed EAI_AGAIN");
  });

  test("a TCP failure after DNS is reported with the cause's code", async () => {
    const r = await probeHost("api.github.com", {
      resolve: async () => ({ address: "192.0.2.1" }),
      head: () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }),
        ),
    });
    expect(r.dnsError).toBeUndefined();
    expect(r.headError).toBe("ETIMEDOUT");
    expect(describe(r).line).toContain("head failed ETIMEDOUT");
  });

  test("a healthy probe is not bad and logs its status", async () => {
    const r = await probeHost("api.github.com", {
      resolve: async () => ({}),
      head: async () => ({ status: 204 }),
    });
    expect(describe(r)).toMatchObject({ bad: false });
    expect(describe(r).line).toContain("status 204");
  });

  test("errorCode never returns message text", () => {
    expect(errorCode(new Error("token=secret"))).toBe("Error");
    expect(errorCode(Object.assign(new Error("x"), { code: "not a code; token=1" }))).toBe("Error");
  });

  test("the loop logs a failure on its first tick", async () => {
    const lines: string[] = [];
    const fail = true;
    const t = 0;
    const stop = startEgressProbe(
      { periodSeconds: 3600, hosts: ["github.com"], dnsOnly: [] },
      (m) => lines.push(m),
      {
        now: () => t,
        resolve: () =>
          fail
            ? Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }))
            : Promise.resolve({}),
        head: async () => ({ status: 200 }),
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(lines.some((l) => l.includes("dns failed ENOTFOUND"))).toBe(true);
  });
});

group("resolver config", () => {
  test("keeps nameserver, search and options lines only", () => {
    expect(
      resolverConfig(
        "# generated\nnameserver 10.0.0.2\noptions timeout:5 attempts:2\nsearch railway.internal\nfoo bar\n",
      ),
    ).toBe("nameserver 10.0.0.2; options timeout:5 attempts:2; search railway.internal");
    expect(resolverConfig("# nothing\n")).toBeUndefined();
  });
});
