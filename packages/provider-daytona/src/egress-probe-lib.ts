// Pure parts of the Daytona egress probe (scripts/egress-probe.ts): the DNS query builder and
// response decoder, the probe plan, the verdict rules and the report shape. Nothing here touches
// the network or Daytona, so it is unit-testable. The script runs the plan inside a sandbox.
//
// Principle: every probe is judged by CONTENT (a status line, body bytes, a decoded DNS answer),
// never by a successful connect. Daytona accepts some TCP connects and then drops them.

export type EgressClass = "none" | "deny-all-except-proxy" | "proxy-domain-filtered";

/** Classes whose LEAK fails the run. The domain class is L7-only by design, so it is reported only. */
export const ENFORCED_CLASSES: readonly EgressClass[] = ["none", "deny-all-except-proxy"];

// ---------------------------------------------------------------------------------------------
// DNS

const RCODE_NAMES = ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED"];

export function rcodeName(rcode: number): string {
  return RCODE_NAMES[rcode] ?? `RCODE${rcode}`;
}

/** An A query (recursion desired) for `name` with transaction id `id`. */
export function buildDnsQuery(name: string, id: number): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new RangeError("id must be 16 bits");
  const labels = name.replace(/\.$/, "").split(".");
  const out: number[] = [id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
  let total = 1;
  for (const l of labels) {
    if (l.length < 1 || l.length > 63) throw new RangeError(`bad DNS label in ${name}`);
    total += l.length + 1;
    out.push(l.length);
    for (const ch of new TextEncoder().encode(l)) out.push(ch);
  }
  if (total > 255) throw new RangeError(`DNS name too long: ${name}`);
  out.push(0, 0, 1, 0, 1); // root, QTYPE A, QCLASS IN
  return Uint8Array.from(out);
}

/** TCP DNS framing: a two-byte length in front of the message. */
export function frameDnsTcp(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(msg.length + 2);
  out[0] = msg.length >> 8;
  out[1] = msg.length & 0xff;
  out.set(msg, 2);
  return out;
}

/** Removes the TCP length prefix; undefined when the bytes are shorter than the prefix says. */
export function unframeDnsTcp(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 2) return undefined;
  const len = (bytes[0]! << 8) | bytes[1]!;
  if (bytes.length < 2 + len) return undefined;
  return bytes.subarray(2, 2 + len);
}

export type DnsDecoded =
  | { kind: "none"; reason: string }
  | {
      kind: "response";
      id: number;
      rcode: number;
      rcodeName: string;
      truncated: boolean;
      /** The IPv4 addresses of the A records in the answer section. */
      answers: string[];
    };

/** Index just past a (possibly compressed) name, or -1 when it runs off the message. */
function skipName(b: Uint8Array, start: number): number {
  let off = start;
  for (;;) {
    const len = b[off];
    if (len === undefined) return -1;
    if ((len & 0xc0) === 0xc0) return off + 1 < b.length ? off + 2 : -1;
    if ((len & 0xc0) !== 0) return -1;
    if (len === 0) return off + 1;
    off += 1 + len;
  }
}

/**
 * Decodes a DNS response. Anything that is not a well-formed response (too short, not a response,
 * a different transaction id, cut off mid-record) is `none`: it is not an answer.
 */
export function decodeDnsResponse(b: Uint8Array, expectId?: number): DnsDecoded {
  if (b.length < 12) return { kind: "none", reason: "shorter than a DNS header" };
  const id = (b[0]! << 8) | b[1]!;
  const flags = (b[2]! << 8) | b[3]!;
  if ((flags & 0x8000) === 0) return { kind: "none", reason: "not a response" };
  if (expectId !== undefined && id !== expectId) return { kind: "none", reason: "id mismatch" };
  const qd = (b[4]! << 8) | b[5]!;
  const an = (b[6]! << 8) | b[7]!;
  const rcode = flags & 0x0f;
  const truncated = (flags & 0x0200) !== 0;
  let off = 12;
  for (let i = 0; i < qd; i++) {
    off = skipName(b, off);
    if (off < 0 || off + 4 > b.length) return { kind: "none", reason: "cut off in the question" };
    off += 4;
  }
  const answers: string[] = [];
  for (let i = 0; i < an; i++) {
    off = skipName(b, off);
    if (off < 0 || off + 10 > b.length) return { kind: "none", reason: "cut off in an answer" };
    const type = (b[off]! << 8) | b[off + 1]!;
    const rdlen = (b[off + 8]! << 8) | b[off + 9]!;
    off += 10;
    if (off + rdlen > b.length) return { kind: "none", reason: "cut off in record data" };
    if (type === 1 && rdlen === 4) {
      answers.push(`${b[off]}.${b[off + 1]}.${b[off + 2]}.${b[off + 3]}`);
    }
    off += rdlen;
  }
  return { kind: "response", id, rcode, rcodeName: rcodeName(rcode), truncated, answers };
}

// ---------------------------------------------------------------------------------------------
// Hex and HTTP helpers

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

/** The status code of a raw HTTP reply (`HTTP/1.1 200 OK`), or undefined when it is not one. */
export function parseHttpStatusLine(bytes: Uint8Array): number | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  const m = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(head);
  return m ? Number(m[1]) : undefined;
}

/** The default gateway of /proc/net/route (little-endian hex), as a dotted quad. */
export function parseGatewayFromProcNetRoute(text: string): string | undefined {
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== "00000000") continue;
    const g = f[2]!;
    if (!/^[0-9A-Fa-f]{8}$/.test(g) || g === "00000000") continue;
    const o = [6, 4, 2, 0].map((i) => parseInt(g.slice(i, i + 2), 16));
    return o.join(".");
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Probes, raw outcomes and verdicts

export type ProbeKind = "http" | "tcp" | "dns-udp" | "dns-tcp" | "sysdns" | "gw-get" | "gw-connect";
/** `control` probes must get an answer (they prove the probe machinery works). */
export type ProbeRole = "probe" | "control";

export type RawOutcome =
  | { kind: "http"; status: number | null; bodyBytes: number; error?: string }
  | { kind: "tcp"; connected: boolean; bytes: number; firstHex: string; error?: string }
  | { kind: "dns"; replyHex: string | null; error?: string }
  | { kind: "sysdns"; addresses: string[]; error?: string }
  | { kind: "missing"; error: string };

export type Verdict = "blocked" | "LEAK" | "control-ok" | "inconclusive";

export type ProbeSpec = {
  id: string;
  kind: ProbeKind;
  role: ProbeRole;
  /** Human-readable target for the report. */
  target: string;
  /** The random name this probe asks a resolver for; its answer is judged by the operator's NS log. */
  forwardedName?: string;
  /** DNS probes: the transaction id and whether the name is a real one (`example.com`). */
  dnsId?: number;
  /** What the in-sandbox runner is told to do. */
  run: Record<string, unknown>;
};

export type ProbeJudgement = { answered: boolean; detail: string };

/** What counts as a real answer, per probe kind. */
export function judge(cls: EgressClass, probe: ProbeSpec, raw: RawOutcome): ProbeJudgement {
  if (raw.kind === "missing") return { answered: false, detail: `no result: ${raw.error}` };
  switch (probe.kind) {
    case "http": {
      if (raw.kind !== "http") break;
      if (raw.status === null) return { answered: false, detail: raw.error ?? "no response" };
      // Daytona's domain filter answers an unlisted name with its own 403; that is the refusal.
      if (cls === "proxy-domain-filtered" && raw.status === 403 && probe.role === "probe") {
        return { answered: false, detail: "403 treated as the domain filter's refusal" };
      }
      return { answered: true, detail: `HTTP ${raw.status}, ${raw.bodyBytes} body bytes` };
    }
    case "tcp": {
      if (raw.kind !== "tcp") break;
      if (raw.bytes === 0) {
        return { answered: false, detail: `0 bytes${raw.connected ? " (connect accepted)" : ""}` };
      }
      return { answered: true, detail: `${raw.bytes} bytes returned` };
    }
    case "gw-get":
    case "gw-connect": {
      if (raw.kind !== "tcp") break;
      if (raw.bytes === 0) return { answered: false, detail: "0 bytes" };
      const status = parseHttpStatusLine(fromHex(raw.firstHex));
      if (status === undefined) return { answered: true, detail: `${raw.bytes} non-HTTP bytes` };
      // A 4xx or 5xx from the gateway is its own refusal, not the target's answer.
      const ok = probe.kind === "gw-connect" ? status >= 200 && status < 300 : status < 400;
      return { answered: ok, detail: `gateway replied HTTP ${status}` };
    }
    case "dns-udp":
    case "dns-tcp": {
      if (raw.kind !== "dns") break;
      if (raw.replyHex === null) return { answered: false, detail: raw.error ?? "no reply" };
      let bytes = fromHex(raw.replyHex);
      if (probe.kind === "dns-tcp") {
        const un = unframeDnsTcp(bytes);
        if (!un) return { answered: false, detail: "truncated TCP reply" };
        bytes = un;
      }
      const d = decodeDnsResponse(bytes, probe.dnsId);
      if (d.kind === "none") return { answered: false, detail: `not an answer: ${d.reason}` };
      // NXDOMAIN, SERVFAIL, REFUSED and an empty NOERROR are not an answer. An A record is.
      if (d.rcode === 0 && d.answers.length > 0) {
        return { answered: true, detail: `${d.rcodeName}, A ${d.answers.join(",")}` };
      }
      return { answered: false, detail: `${d.rcodeName}, no A record` };
    }
    case "sysdns": {
      if (raw.kind !== "sysdns") break;
      if (raw.addresses.length > 0) {
        return { answered: true, detail: `resolved to ${raw.addresses.join(",")}` };
      }
      return { answered: false, detail: raw.error ?? "no addresses" };
    }
  }
  return { answered: false, detail: `unexpected outcome shape ${raw.kind} for ${probe.kind}` };
}

/** The verdict for one probe: control probes must answer; every other answer is a LEAK. */
export function verdictFor(cls: EgressClass, probe: ProbeSpec, raw: RawOutcome): Verdict {
  if (raw.kind === "missing") return "inconclusive";
  const j = judge(cls, probe, raw);
  if (probe.role === "control") return j.answered ? "control-ok" : "inconclusive";
  return j.answered ? "LEAK" : "blocked";
}

export type ProbeReport = {
  id: string;
  kind: ProbeKind;
  role: ProbeRole;
  target: string;
  verdict: Verdict;
  detail: string;
  raw: RawOutcome;
};

export type ClassReport = {
  class: EgressClass;
  /** Sent-at times and names for the operator's authoritative-NS log check. */
  forwardedQueries: { name: string; sentAt: string }[];
  probes: ProbeReport[];
};

export function reportProbe(cls: EgressClass, probe: ProbeSpec, raw: RawOutcome): ProbeReport {
  return {
    id: probe.id,
    kind: probe.kind,
    role: probe.role,
    target: probe.target,
    verdict: verdictFor(cls, probe, raw),
    detail: judge(cls, probe, raw).detail,
    raw,
  };
}

/**
 * 1 when any probe of `none` or `deny-all-except-proxy` got a real answer (the class is not
 * enforced); else 2 when any probe or control was inconclusive (the run proves nothing); else 0.
 * A LEAK under the domain class is reported but does not fail the run.
 */
export function exitCodeFor(reports: readonly ClassReport[]): 0 | 1 | 2 {
  const leaked = reports.some(
    (r) => ENFORCED_CLASSES.includes(r.class) && r.probes.some((p) => p.verdict === "LEAK"),
  );
  if (leaked) return 1;
  const inconclusive = reports.some((r) => r.probes.some((p) => p.verdict === "inconclusive"));
  return inconclusive ? 2 : 0;
}

// ---------------------------------------------------------------------------------------------
// The plan

export type PlanInput = {
  cls: EgressClass;
  publicName: string;
  publicIp: string;
  resolvers: readonly string[];
  /** The zone whose authoritative NS the operator controls and logs. */
  probeZone: string;
  /** A random label, unique to this class and run. */
  randomLabel: string;
  /** The default gateway read from the route table, if any. */
  gateway: string | undefined;
  /** The Host header to spoof (an allowed name). */
  spoofHost: string;
  /** `deny-all-except-proxy`: the allow-listed address. `proxy-domain-filtered`: the allowed name. */
  allowed?: string;
};

export function buildProbePlan(p: PlanInput): ProbeSpec[] {
  const out: ProbeSpec[] = [];
  const randomName = `${p.randomLabel}.${p.probeZone}`;
  const httpGet = (host: string): string =>
    toHex(new TextEncoder().encode(`GET / HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));

  const http = (id: string, url: string, headers?: Record<string, string>): void => {
    out.push({
      id,
      kind: "http",
      role: "probe",
      target: headers?.Host ? `${url} (Host: ${headers.Host})` : url,
      run: { kind: "http", id, url, ...(headers ? { headers } : {}) },
    });
  };
  http("http-name", `http://${p.publicName}/`);
  http("https-name", `https://${p.publicName}/`);
  http("http-ip", `http://${p.publicIp}/`);
  http("https-ip", `https://${p.publicIp}/`);
  http("http-ip-spoofed-host", `http://${p.publicIp}/`, { Host: p.spoofHost });

  out.push({
    id: "tcp-raw-http",
    kind: "tcp",
    role: "probe",
    target: `${p.publicIp}:80 (raw socket, HTTP request)`,
    run: {
      kind: "tcp",
      id: "tcp-raw-http",
      host: p.publicIp,
      port: 80,
      sendHex: httpGet(p.publicName),
    },
  });

  let n = 0x5400;
  for (const r of p.resolvers) {
    for (const [suffix, name, forwarded] of [
      ["real", p.publicName, false],
      ["random", randomName, true],
    ] as const) {
      for (const transport of ["udp", "tcp"] as const) {
        const dnsId = n++;
        const q = buildDnsQuery(name, dnsId);
        const id = `dns-${transport}-${r}-${suffix}`;
        out.push({
          id,
          kind: transport === "udp" ? "dns-udp" : "dns-tcp",
          role: "probe",
          target: `${name} A via ${r}:53/${transport}`,
          dnsId,
          ...(forwarded ? { forwardedName: name } : {}),
          run: {
            kind: transport === "udp" ? "dns-udp" : "dns-tcp",
            id,
            host: r,
            port: 53,
            sendHex: toHex(transport === "udp" ? q : frameDnsTcp(q)),
          },
        });
      }
    }
  }
  for (const [suffix, name, forwarded] of [
    ["real", p.publicName, false],
    ["random", randomName, true],
  ] as const) {
    const id = `sysdns-${suffix}`;
    out.push({
      id,
      kind: "sysdns",
      role: "probe",
      target: `${name} via the system resolver`,
      ...(forwarded ? { forwardedName: name } : {}),
      run: { kind: "sysdns", id, name },
    });
  }

  if (p.gateway) {
    out.push({
      id: "gateway-18080-get",
      kind: "gw-get",
      role: "probe",
      target: `${p.gateway}:18080 forward proxy, GET http://${p.publicName}/`,
      run: {
        kind: "tcp",
        id: "gateway-18080-get",
        host: p.gateway,
        port: 18080,
        sendHex: toHex(
          new TextEncoder().encode(
            `GET http://${p.publicName}/ HTTP/1.0\r\nHost: ${p.publicName}\r\n\r\n`,
          ),
        ),
      },
    });
    out.push({
      id: "gateway-18080-connect",
      kind: "gw-connect",
      role: "probe",
      target: `${p.gateway}:18080 forward proxy, CONNECT ${p.publicName}:443`,
      run: {
        kind: "tcp",
        id: "gateway-18080-connect",
        host: p.gateway,
        port: 18080,
        sendHex: toHex(
          new TextEncoder().encode(
            `CONNECT ${p.publicName}:443 HTTP/1.1\r\nHost: ${p.publicName}:443\r\n\r\n`,
          ),
        ),
      },
    });
  }

  if (p.cls === "deny-all-except-proxy" && p.allowed) {
    out.push({
      id: "control-allowed-address",
      kind: "http",
      role: "control",
      target: `http://${p.allowed}/ (the allow-listed address; must answer)`,
      run: { kind: "http", id: "control-allowed-address", url: `http://${p.allowed}/` },
    });
  }
  if (p.cls === "proxy-domain-filtered" && p.allowed) {
    out.push({
      id: "control-allowed-name",
      kind: "http",
      role: "control",
      target: `https://${p.allowed}/ (the allowed name; must answer)`,
      run: { kind: "http", id: "control-allowed-name", url: `https://${p.allowed}/` },
    });
  }
  return out;
}

/** Collects the runner's `PROBE {json}` lines; probes with no line become `missing`. */
export function parseRunnerOutput(
  stdout: string,
  plan: readonly ProbeSpec[],
): Map<string, RawOutcome> {
  const got = new Map<string, RawOutcome>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("PROBE ")) continue;
    try {
      const o = JSON.parse(line.slice(6)) as { id?: string; raw?: RawOutcome };
      if (typeof o.id === "string" && o.raw && typeof o.raw === "object") got.set(o.id, o.raw);
    } catch {
      // a damaged line is a missing result, which is inconclusive
    }
  }
  for (const p of plan) {
    if (!got.has(p.id)) got.set(p.id, { kind: "missing", error: "the runner printed no result" });
  }
  return got;
}

// ---------------------------------------------------------------------------------------------
// The in-sandbox runner (plain CommonJS for `node -e`; the image has node but no nc).
// It only collects RAW outcomes; every decision is made on the host by `judge`.

export const SANDBOX_RUNNER_JS = String.raw`
const net = require("net");
const dgram = require("dgram");
const http = require("http");
const https = require("https");
const dns = require("dns");
const params = JSON.parse(process.argv[process.argv.length - 1]);
const T = params.timeoutMs || 8000;
const emit = (id, raw) => console.log("PROBE " + JSON.stringify({ id, raw }));
const code = (e) => String((e && (e.code || e.message)) || e);
const cap = (ms, p, dflt) => Promise.race([p, new Promise((r) => setTimeout(() => r(dflt), ms))]);

function httpProbe(p) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(Object.assign({ kind: "http" }, r)); } };
    let req;
    try {
      const u = new URL(p.url);
      const lib = u.protocol === "https:" ? https : http;
      req = lib.request({
        method: "GET", host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, rejectUnauthorized: false, timeout: T,
        headers: Object.assign({ "user-agent": "turntable-egress-probe", connection: "close" }, p.headers || {}),
      }, (r) => {
        let n = 0;
        r.on("data", (c) => { n += c.length; if (n > 65536) r.destroy(); });
        r.on("end", () => fin({ status: r.statusCode, bodyBytes: n }));
        r.on("error", (e) => fin({ status: r.statusCode, bodyBytes: n, error: code(e) }));
        r.on("close", () => fin({ status: r.statusCode, bodyBytes: n }));
      });
      req.on("timeout", () => { req.destroy(); fin({ status: null, bodyBytes: 0, error: "timeout" }); });
      req.on("error", (e) => fin({ status: null, bodyBytes: 0, error: code(e) }));
      req.end();
    } catch (e) { fin({ status: null, bodyBytes: 0, error: code(e) }); }
    setTimeout(() => { try { req && req.destroy(); } catch (e) {} fin({ status: null, bodyBytes: 0, error: "hard-timeout" }); }, T + 2000);
  });
}

function tcpProbe(p, wantFull) {
  return new Promise((resolve) => {
    let connected = false, done = false;
    const chunks = [];
    let total = 0;
    const s = new net.Socket();
    const fin = (error) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      const buf = Buffer.concat(chunks);
      resolve({ connected, bytes: total, firstHex: buf.subarray(0, 512).toString("hex"), error });
    };
    s.setTimeout(T, () => fin("timeout"));
    s.on("error", (e) => fin(code(e)));
    s.on("close", () => fin(undefined));
    s.on("data", (c) => {
      total += c.length;
      if (total <= 4096) chunks.push(c);
      if (wantFull && wantFull(Buffer.concat(chunks))) fin(undefined);
    });
    s.connect(p.port, p.host, () => { connected = true; s.write(Buffer.from(p.sendHex, "hex")); });
  });
}

function dnsTcpProbe(p) {
  const complete = (b) => b.length >= 2 && b.length >= 2 + ((b[0] << 8) | b[1]);
  return tcpProbe(p, complete).then((r) => ({ kind: "dns", replyHex: r.bytes > 0 ? r.firstHex : null, error: r.error }));
}

function dnsUdpProbe(p) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    let done = false;
    const fin = (r) => { if (!done) { done = true; try { s.close(); } catch (e) {} resolve(Object.assign({ kind: "dns" }, r)); } };
    const t = setTimeout(() => fin({ replyHex: null, error: "timeout" }), T);
    s.on("error", (e) => { clearTimeout(t); fin({ replyHex: null, error: code(e) }); });
    s.on("message", (m) => { clearTimeout(t); fin({ replyHex: m.toString("hex") }); });
    s.send(Buffer.from(p.sendHex, "hex"), p.port, p.host, (e) => { if (e) { clearTimeout(t); fin({ replyHex: null, error: code(e) }); } });
  });
}

function sysdnsProbe(p) {
  const r = new Promise((resolve) => {
    dns.lookup(p.name, { all: true, family: 4 }, (e, a) =>
      resolve(e ? { kind: "sysdns", addresses: [], error: code(e) } : { kind: "sysdns", addresses: a.map((x) => x.address) }));
  });
  return cap(T, r, { kind: "sysdns", addresses: [], error: "timeout" });
}

(async () => {
  for (const p of params.probes) {
    let raw;
    try {
      if (p.kind === "http") raw = await httpProbe(p);
      else if (p.kind === "tcp") { const r = await tcpProbe(p); raw = Object.assign({ kind: "tcp" }, r); }
      else if (p.kind === "dns-udp") raw = await dnsUdpProbe(p);
      else if (p.kind === "dns-tcp") raw = await dnsTcpProbe(p);
      else if (p.kind === "sysdns") raw = await sysdnsProbe(p);
      else raw = { kind: "missing", error: "unknown probe kind " + p.kind };
    } catch (e) { raw = { kind: "missing", error: "runner exception: " + code(e) }; }
    emit(p.id, raw);
  }
})();
setTimeout(() => process.exit(0), (params.totalMs || 240000)).unref();
`;
