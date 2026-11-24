import { describe, expect, test } from "bun:test";
import {
  buildDnsQuery,
  buildProbePlan,
  decodeDnsResponse,
  exitCodeFor,
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
