import { describe, expect, test } from "bun:test";
import {
  applyAnalytics,
  buildBurst,
  forwardLabelNames,
  interpretAnalytics,
  makeRunId,
  missProbability,
  parseAnalyticsResult,
  parseBurstOutput,
  parseForwardLabels,
  renderForwardCheck,
  type ForwardCheck,
  buildDnsQuery,
  buildProbePlan,
  decodeDnsResponse,
  exitCodeFor,
  identityMeetsRequirement,
  parseIdentityOutput,
  fromHex,
  frameDnsTcp,
  parseGatewayFromProcNetRoute,
  parseHttpStatusLine,
  parseRunnerOutput,
  reportProbe,
  SANDBOX_RUNNER_JS,
  toHex,
  unframeDnsTcp,
  verdictFor,
  type ClassReport,
  type EgressClass,
  type ProbeSpec,
  type RawOutcome,
} from "../src/egress-probe-lib";

const EXAMPLE_QUERY_HEX = "123401000001000000000000076578616d706c6503636f6d0000010001";
// id 0x1234, QR+RD+RA, one question, one answer: example.com A 93.184.216.34 (name by pointer)
const A_RESPONSE_HEX =
  "123481800001000100000000076578616d706c6503636f6d0000010001" + "c00c000100010000003c00045db8d822";
// same question, rcode 3 (NXDOMAIN), no answers
const NX_RESPONSE_HEX = "123481830001000000000000076578616d706c6503636f6d0000010001";

describe("DNS encoder and decoder", () => {
  test("the query bytes are fixed", () => {
    expect(toHex(buildDnsQuery("example.com", 0x1234))).toBe(EXAMPLE_QUERY_HEX);
    expect(toHex(buildDnsQuery("example.com.", 0x1234))).toBe(EXAMPLE_QUERY_HEX);
  });

  test("rejects bad names and ids", () => {
    expect(() => buildDnsQuery("a..b", 1)).toThrow();
    expect(() => buildDnsQuery(`${"a".repeat(64)}.com`, 1)).toThrow();
    expect(() => buildDnsQuery("example.com", 70000)).toThrow();
  });

  test("NOERROR with an A record", () => {
    const d = decodeDnsResponse(fromHex(A_RESPONSE_HEX), 0x1234);
    expect(d).toEqual({
      kind: "response",
      id: 0x1234,
      rcode: 0,
      rcodeName: "NOERROR",
      truncated: false,
      answers: ["93.184.216.34"],
    });
  });

  test("NXDOMAIN", () => {
    const d = decodeDnsResponse(fromHex(NX_RESPONSE_HEX));
    expect(d.kind === "response" && d.rcodeName).toBe("NXDOMAIN");
    expect(d.kind === "response" && d.answers).toEqual([]);
  });

  test("truncated, garbage, a query and the wrong id are not answers", () => {
    const full = fromHex(A_RESPONSE_HEX);
    for (const n of [0, 5, 11, 20, full.length - 1]) {
      expect(decodeDnsResponse(full.subarray(0, n)).kind).toBe("none");
    }
    expect(decodeDnsResponse(new Uint8Array(40).fill(0xff)).kind).toBe("none");
    expect(decodeDnsResponse(fromHex(EXAMPLE_QUERY_HEX)).kind).toBe("none");
    expect(decodeDnsResponse(fromHex(A_RESPONSE_HEX), 0x9999).kind).toBe("none");
  });

  test("TCP framing round trips and a short frame is nothing", () => {
    const q = buildDnsQuery("example.com", 1);
    expect(unframeDnsTcp(frameDnsTcp(q))).toEqual(q);
    expect(unframeDnsTcp(frameDnsTcp(q).subarray(0, 10))).toBeUndefined();
    expect(unframeDnsTcp(new Uint8Array(1))).toBeUndefined();
  });
});

describe("helpers", () => {
  test("HTTP status line", () => {
    expect(parseHttpStatusLine(new TextEncoder().encode("HTTP/1.1 301 Moved\r\n"))).toBe(301);
    expect(parseHttpStatusLine(new TextEncoder().encode("SSH-2.0-x"))).toBeUndefined();
  });

  test("default gateway from the route table", () => {
    const t =
      "Iface\tDestination\tGateway\tFlags\n" +
      "eth0\t00000000\t0100140A\t0003\neth0\t0000140A\t00000000\t0001\n";
    expect(parseGatewayFromProcNetRoute(t)).toBe("10.20.0.1");
    expect(parseGatewayFromProcNetRoute("Iface\tDestination\tGateway\n")).toBeUndefined();
  });

  test("the sandbox runner parses as JavaScript", () => {
    expect(
      () => new Function("require", "process", `return async () => {${SANDBOX_RUNNER_JS}}`),
    ).not.toThrow();
  });
});

const probe = (kind: ProbeSpec["kind"], over: Partial<ProbeSpec> = {}): ProbeSpec => ({
  id: "p",
  kind,
  role: "probe",
  target: "t",
  run: {},
  ...over,
});
const tcp = (bytes: number, hex = "", connected = true): RawOutcome => ({
  kind: "tcp",
  connected,
  bytes,
  firstHex: hex,
});
const http = (status: number | null): RawOutcome => ({ kind: "http", status, bodyBytes: 0 });
const dnsRaw = (replyHex: string | null): RawOutcome => ({ kind: "dns", replyHex });

describe("verdict rules", () => {
  test("a 0-byte raw TCP result is blocked, even when the connect was accepted", () => {
    expect(verdictFor("none", probe("tcp"), tcp(0))).toBe("blocked");
    expect(verdictFor("none", probe("tcp"), tcp(120, "48"))).toBe("LEAK");
  });

  test("any HTTP status is a LEAK for none, no response is blocked", () => {
    for (const s of [200, 301, 403, 404, 500]) {
      expect(verdictFor("none", probe("http"), http(s))).toBe("LEAK");
    }
    expect(verdictFor("none", probe("http"), http(null))).toBe("blocked");
  });

  test("the domain class treats its own 403 as a refusal but not a 200", () => {
    expect(verdictFor("proxy-domain-filtered", probe("http"), http(403))).toBe("blocked");
    expect(verdictFor("proxy-domain-filtered", probe("http"), http(200))).toBe("LEAK");
  });

  test("DNS: a decoded A record is a LEAK, NXDOMAIN and junk are blocked", () => {
    const udp = probe("dns-udp", { dnsId: 0x1234 });
    expect(verdictFor("none", udp, dnsRaw(A_RESPONSE_HEX))).toBe("LEAK");
    expect(verdictFor("none", udp, dnsRaw(NX_RESPONSE_HEX))).toBe("blocked");
    expect(verdictFor("none", udp, dnsRaw("deadbeef"))).toBe("blocked");
    expect(verdictFor("none", udp, dnsRaw(null))).toBe("blocked");
    const t = probe("dns-tcp", { dnsId: 0x1234 });
    const framed = (h: string) => toHex(frameDnsTcp(fromHex(h)));
    expect(verdictFor("none", t, dnsRaw(framed(A_RESPONSE_HEX)))).toBe("LEAK");
    expect(verdictFor("none", t, dnsRaw(framed(NX_RESPONSE_HEX)))).toBe("blocked");
    expect(verdictFor("none", t, dnsRaw(A_RESPONSE_HEX.slice(0, 30)))).toBe("blocked");
  });

  test("system resolver: addresses leak, an error is blocked", () => {
    const p = probe("sysdns");
    expect(verdictFor("none", p, { kind: "sysdns", addresses: ["1.2.3.4"] })).toBe("LEAK");
    expect(verdictFor("none", p, { kind: "sysdns", addresses: [], error: "ENOTFOUND" })).toBe(
      "blocked",
    );
  });

  test("gateway proxy: a target answer leaks, the gateway's own 403 does not", () => {
    const hex = (s: string) => toHex(new TextEncoder().encode(s));
    const get = probe("gw-get");
    expect(verdictFor("none", get, tcp(20, hex("HTTP/1.1 200 OK\r\n")))).toBe("LEAK");
    expect(verdictFor("none", get, tcp(20, hex("HTTP/1.1 403 Forbidden\r\n")))).toBe("blocked");
    const c = probe("gw-connect");
    expect(verdictFor("none", c, tcp(40, hex("HTTP/1.1 200 Connection established\r\n")))).toBe(
      "LEAK",
    );
    expect(verdictFor("none", c, tcp(0))).toBe("blocked");
  });

  test("controls must answer; a missing result is inconclusive, never blocked", () => {
    const c = probe("http", { role: "control" });
    expect(verdictFor("deny-all-except-proxy", c, http(200))).toBe("control-ok");
    expect(verdictFor("deny-all-except-proxy", c, http(null))).toBe("inconclusive");
    expect(verdictFor("none", probe("http"), { kind: "missing", error: "x" })).toBe("inconclusive");
  });
});

describe("plan and runner output", () => {
  const base = {
    publicName: "example.com",
    publicIp: "1.1.1.1",
    resolvers: ["1.1.1.1", "8.8.8.8"],
    probeZone: "probe.test",
    randomLabel: "tt0123abcdn",
    gateway: "172.20.0.1" as string | undefined,
    spoofHost: "example.com",
  };

  test("covers every required probe and names the forwarded queries", () => {
    const plan = buildProbePlan({ ...base, cls: "none" });
    const ids = plan.map((p) => p.id);
    for (const want of [
      "http-name",
      "https-name",
      "http-ip",
      "https-ip",
      "http-ip-spoofed-host",
      "tcp-raw-http",
      "dns-udp-1.1.1.1-real",
      "dns-tcp-8.8.8.8-random",
      "sysdns-random",
      "gateway-18080-get",
      "gateway-18080-connect",
    ]) {
      expect(ids).toContain(want);
    }
    const fwd = plan.filter((p) => p.forwardedName).map((p) => p.forwardedName);
    expect(new Set(fwd)).toEqual(new Set(["tt0123abcdn.probe.test"]));
    expect(new Set(plan.map((p) => p.id)).size).toBe(plan.length);
  });

  test("no gateway means no gateway probes; strict and domain add a control", () => {
    expect(
      buildProbePlan({ ...base, cls: "none", gateway: undefined }).some((p) =>
        p.id.startsWith("gateway"),
      ),
    ).toBe(false);
    expect(buildProbePlan({ ...base, cls: "none" }).some((p) => p.role === "control")).toBe(false);
    expect(
      buildProbePlan({ ...base, cls: "deny-all-except-proxy", allowed: "203.0.113.9" }).filter(
        (p) => p.role === "control",
      ),
    ).toHaveLength(1);
    expect(
      buildProbePlan({ ...base, cls: "proxy-domain-filtered", allowed: "allowed.test" }).filter(
        (p) => p.role === "control",
      ),
    ).toHaveLength(1);
  });

  test("DNS probes carry the query for their own transaction id", () => {
    const plan = buildProbePlan({ ...base, cls: "none" });
    const udp = plan.find((p) => p.id === "dns-udp-1.1.1.1-real")!;
    const sent = fromHex(udp.run.sendHex as string);
    expect((sent[0]! << 8) | sent[1]!).toBe(udp.dnsId!);
  });

  test("runner output: results are matched by id, a damaged or absent line is missing", () => {
    const plan = [
      probe("http", { id: "a" }),
      probe("http", { id: "b" }),
      probe("http", { id: "c" }),
    ];
    const out = [
      'PROBE {"id":"a","raw":{"kind":"http","status":200,"bodyBytes":3}}',
      "noise",
      'PROBE {"id":"b"',
    ].join("\n");
    const m = parseRunnerOutput(out, plan);
    expect(m.get("a")).toEqual({ kind: "http", status: 200, bodyBytes: 3 });
    expect(m.get("b")?.kind).toBe("missing");
    expect(m.get("c")?.kind).toBe("missing");
  });
});

describe("report exit code", () => {
  const rep = (cls: EgressClass, ...raws: [ProbeSpec, RawOutcome][]): ClassReport => ({
    class: cls,
    forwardedQueries: [],
    probes: raws.map(([p, r]) => reportProbe(cls, p, r)),
  });
  const ok = [probe("tcp"), tcp(0)] as [ProbeSpec, RawOutcome];
  const leak = [probe("http"), http(200)] as [ProbeSpec, RawOutcome];
  const missing = [probe("http"), { kind: "missing", error: "x" }] as [ProbeSpec, RawOutcome];

  test("0 when everything is blocked", () => {
    expect(exitCodeFor([rep("none", ok), rep("deny-all-except-proxy", ok)])).toBe(0);
  });
  test("1 for a LEAK in none or deny-all-except-proxy", () => {
    expect(exitCodeFor([rep("none", leak)])).toBe(1);
    expect(exitCodeFor([rep("none", ok), rep("deny-all-except-proxy", leak)])).toBe(1);
  });
  test("a LEAK in the domain class is reported but does not fail the run", () => {
    expect(exitCodeFor([rep("none", ok), rep("proxy-domain-filtered", leak)])).toBe(0);
  });
  test("2 when a result is inconclusive, 1 still wins over 2", () => {
    expect(exitCodeFor([rep("none", missing)])).toBe(2);
    expect(exitCodeFor([rep("none", missing, leak)])).toBe(1);
  });
});

describe("forwarded-query labels for a sampled dataset", () => {
  const run = makeRunId(new Uint8Array(10).map((_, i) => i * 7));
  test("run id is 10 lowercase letters", () => {
    expect(run).toMatch(/^[a-z]{10}$/);
    expect(() => makeRunId(new Uint8Array(3))).toThrow();
  });
  test("N distinct labels share one prefix and are valid DNS labels", () => {
    const names = forwardLabelNames(run, 200, "probe.example");
    expect(new Set(names).size).toBe(200);
    for (const n of names) {
      expect(n.startsWith(`eprobe-${run}-`)).toBe(true);
      const label = n.split(".")[0]!;
      expect(label.length).toBeLessThanOrEqual(63);
      expect(label).toMatch(/^[a-z0-9-]+$/);
      expect(buildDnsQuery(n, 1).length).toBeGreaterThan(12);
    }
    expect(names[0]).toBe(`eprobe-${run}-0.probe.example`);
    expect(forwardLabelNames(run, 2, "z.example", 50)[0]).toBe(`eprobe-${run}-50.z.example`);
  });
  test("flag range is 10 to 200, default 50", () => {
    expect(parseForwardLabels(undefined)).toBe(50);
    expect(parseForwardLabels("10")).toBe(10);
    expect(parseForwardLabels("200")).toBe(200);
    for (const bad of ["9", "201", "0", "-5", "abc", "12.5", ""]) {
      expect(() => parseForwardLabels(bad)).toThrow();
    }
  });
  test("burst sends the last 3 over framed TCP and the rest over UDP", () => {
    const names = forwardLabelNames(run, 50, "z.example");
    const b = buildBurst(names);
    expect(b.udp.length).toBe(47);
    expect(b.tcp.length).toBe(3);
    expect(b.tcp[0]!.name).toBe(names[47]!);
    expect(b.tcp[0]!.sendHex.length / 2).toBe(2 + buildDnsQuery(names[47]!, 0).length);
  });
  test("burst output parses", () => {
    const out = 'noise\nBURST {"sent":{"udp":47,"tcp":3},"first":"a","last":"b"}\n';
    expect(parseBurstOutput(out)).toEqual({ sentUdp: 47, sentTcp: 3, first: "a", last: "b" });
    expect(parseBurstOutput("none")).toBeUndefined();
    expect(parseBurstOutput('BURST {"error":"x"}')).toBeUndefined();
  });
  test("the runner carries the burst code", () => {
    expect(SANDBOX_RUNNER_JS).toContain("params.burst");
  });
});

describe("miss probability and interpretation", () => {
  test("N=50 at sampleInterval 10 is about 0.5%", () => {
    expect(missProbability(50, 10)).toBeCloseTo(0.00515, 4);
    expect(missProbability(50, 1)).toBe(0);
    expect(() => missProbability(50, 0.5)).toThrow();
  });
  test("hits > 0 means forwarding observed", () => {
    const r = interpretAnalytics({ hits: 2, n: 50, sampleInterval: 10, window: "w" });
    expect(r.verdict).toBe("forwarding observed");
  });
  test("hits = 0 is no forwarding observed, never blocked or proof", () => {
    const r = interpretAnalytics({ hits: 0, n: 50, sampleInterval: 10, window: "w" });
    expect(r.verdict).toBe("no forwarding observed");
    expect(r.text).toContain("window w, 50 labels, sampleInterval 10");
    expect(r.text).toContain("not proof");
    expect(r.text.toLowerCase()).not.toContain("blocked");
  });
  const check: ForwardCheck = {
    prefix: "eprobe-abcdefghij-",
    n: 50,
    firstIndex: 0,
    firstSentAt: "2026-11-24T00:00:00.000Z",
    lastSentAt: "2026-11-24T00:01:00.000Z",
    sentUdp: 47,
    sentTcp: 3,
    verdict: "inconclusive",
  };
  const good = { prefix: check.prefix, hits: 0, sampleInterval: 10, window: "w" };
  test("an analytics result for another prefix is rejected", () => {
    expect(() =>
      parseAnalyticsResult({ ...good, prefix: "eprobe-zzzzzzzzzz-" }, check.prefix),
    ).toThrow(/prefix/);
    expect(parseAnalyticsResult(good, check.prefix).hits).toBe(0);
    expect(() => parseAnalyticsResult({ ...good, hits: -1 }, check.prefix)).toThrow();
    expect(() => parseAnalyticsResult({ ...good, sampleInterval: 0 }, check.prefix)).toThrow();
  });
  test("the verdict stays inconclusive until a result is applied", () => {
    expect(check.verdict).toBe("inconclusive");
    const lines = renderForwardCheck("none", check).join("\n");
    expect(lines).toContain('queryName_like: "eprobe-abcdefghij-%"');
    expect(lines).toContain("inconclusive");
    expect(lines).toContain("0.52%");
    const done = applyAnalytics(check, good);
    expect(done.verdict).toBe("no forwarding observed");
    expect(renderForwardCheck("none", done).join("\n")).toContain("no forwarding observed");
  });
});

describe("identity probe parsing", () => {
  test("root with sudo", () => {
    const id = parseIdentityOutput("0\nroot\nsudo-ok\n");
    expect(id).toEqual({ uid: 0, user: "root", sudo: "ok" });
    expect(identityMeetsRequirement(id)).toBe(true);
  });
  test("root without sudo", () => {
    const id = parseIdentityOutput("0\nroot\nsudo-missing\n");
    expect(id).toEqual({ uid: 0, user: "root", sudo: "missing" });
    expect(identityMeetsRequirement(id)).toBe(false);
  });
  test("a user with passwordless sudo", () => {
    const id = parseIdentityOutput("1000\ndaytona\nsudo-ok\n");
    expect(id).toEqual({ uid: 1000, user: "daytona", sudo: "ok" });
    expect(identityMeetsRequirement(id)).toBe(true);
  });
  test("a user without sudo, and one that is denied", () => {
    expect(parseIdentityOutput("1000\ndaytona\nsudo-missing\n")?.sudo).toBe("missing");
    const denied = parseIdentityOutput("1000\ndaytona\nsudo-denied\n");
    expect(denied).toEqual({ uid: 1000, user: "daytona", sudo: "denied" });
    expect(identityMeetsRequirement(denied)).toBe(false);
  });
  test("garbage or no output", () => {
    expect(parseIdentityOutput("")).toBeNull();
    expect(parseIdentityOutput("sh: id: not found\n")).toBeNull();
    expect(identityMeetsRequirement(null)).toBe(false);
    expect(parseIdentityOutput("0\nroot\n")?.sudo).toBe("missing");
  });
});
