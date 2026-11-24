// Live egress probe for the Daytona provider: what each egress class really blocks, measured from
// inside a sandbox. Run BY AN OPERATOR with a Daytona key and explicit approval. It creates real
// sandboxes (one at a time) and is never run by CI.
//
//   bun run packages/provider-daytona/scripts/egress-probe.ts \
//     --i-have-approval --key-file <path> --probe-zone <zone-you-run-an-NS-for> \
//     --allow-address <ipv4> [--include-domain-mode --domain-allow <name>] [--only <class>] [--out report.json]
//
// The key comes from --key-file (a file holding only the key) or the DAYTONA_API_KEY environment
// variable; it is never printed. Safety, as in proxy-spike.ts and live-check.ts: our fleet label
// (turntable-dev) and name prefix, at most one sandbox live at a time (the cap is 2), a TTL of 15
// minutes, delete in finally, the provider's org usage preflight before every create, and a
// refusal to start if sandboxes of our fleet already exist. Reports sandbox-minutes at the end.
//
// Exit code: 1 when `none` or `deny-all-except-proxy` gave a real answer to any probe (the class is
// not enforced on Daytona: refuse it, fail closed); 2 when a probe or control was inconclusive;
// 3 for bad usage or a sandbox left behind; else 0. Each class also reports `identity`
// ({uid, user, sudo: ok|missing|denied}), informational only; with --require-sudo a sandbox that is
// neither root-with-sudo nor passwordless-sudo gives exit code 4 (after codes 1 to 3, which win).
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DaytonaProvider, networkSettingFor, type UsageRecord } from "../src/index";
import {
  applyAnalytics,
  buildBurst,
  buildProbePlan,
  forwardLabelNames,
  makeRunId,
  parseAnalyticsResult,
  parseBurstOutput,
  parseForwardLabels,
  renderForwardCheck,
  type ForwardCheck,
  exitCodeFor,
  identityMeetsRequirement,
  IDENTITY_ARGV,
  parseIdentityOutput,
  parseGatewayFromProcNetRoute,
  parseRunnerOutput,
  reportProbe,
  SANDBOX_RUNNER_JS,
  type ClassReport,
  type EgressClass,
} from "../src/egress-probe-lib";

const FLEET = "turntable-dev";
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PUBLIC_IP = "1.1.1.1";
const RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    [
      "usage: egress-probe.ts --i-have-approval --probe-zone <zone> [--key-file <path>]",
      "         [--allow-address <ipv4>] [--include-domain-mode --domain-allow <name>]",
      "         [--only none|deny-all-except-proxy|proxy-domain-filtered] [--public-name <name>] [--out <file>]",
      "         [--forward-labels <10..200>] [--require-sudo]",
      "       egress-probe.ts --render <report.json> --analytics-result <result.json>   (no network)",
      "",
      "  --i-have-approval    required: this creates real sandboxes in the account the key belongs to",
      "  --key-file <path>    file holding only the Daytona key (or set DAYTONA_API_KEY)",
      "  --probe-zone <zone>  a zone whose authoritative NS you control AND log; queries for",
      "                       <random>.<zone> are sent from each sandbox",
      "  --allow-address <ip> the address to allow-list for deny-all-except-proxy (not 1.1.1.1 or 8.8.8.8)",
      "  --include-domain-mode  also probe proxy-domain-filtered (needs --domain-allow <name>)",
      "  --public-name <name> the public name probed over HTTP(S) and DNS (default example.com)",
      "  --forward-labels <N> distinct names eprobe-<run>-<i>.<zone> sent per class for the analytics",
      "                       check (default 50, 10 to 200)",
      "  --require-sudo       exit 4 when a sandbox is neither root-with-sudo nor passwordless-sudo",
      "  --render <report>    re-print a saved report; with --analytics-result <file> holding",
      "                       {class?, prefix, hits, sampleInterval, window} it records that result",
    ].join("\n"),
  );
  process.exit(3);
}

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
function opt(n: string): string | undefined {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${n} needs a value`);
  return v;
}

if (flag("--help") || flag("-h")) usage();

const renderFile = opt("--render");
const analyticsFile = opt("--analytics-result");
if (analyticsFile && !renderFile) usage("--analytics-result needs --render <report.json>");
if (renderFile) {
  // Offline re-render: no key, no sandbox, no network.
  const saved = JSON.parse(readFileSync(renderFile, "utf8")) as {
    reports: ClassReport[];
    probeZone?: string;
  };
  const withCheck = saved.reports.filter((r) => r.forwardCheck);
  if (analyticsFile) {
    const rawResult = JSON.parse(readFileSync(analyticsFile, "utf8")) as { class?: EgressClass };
    const target = rawResult.class
      ? withCheck.find((r) => r.class === rawResult.class)
      : withCheck.length === 1
        ? withCheck[0]
        : undefined;
    if (!target?.forwardCheck) usage("--analytics-result needs a class matching one report class");
    try {
      target.forwardCheck = applyAnalytics(
        target.forwardCheck,
        parseAnalyticsResult(rawResult, target.forwardCheck.prefix),
      );
    } catch (e) {
      usage(e instanceof Error ? e.message : String(e));
    }
    const renderOut = opt("--out");
    if (renderOut) writeFileSync(renderOut, JSON.stringify(saved, null, 2) + "\n");
  }
  for (const r of withCheck)
    for (const l of renderForwardCheck(r.class, r.forwardCheck!)) console.log(l);
  process.exit(0);
}
if (!flag("--i-have-approval")) usage("refusing to run without --i-have-approval");
const keyFile = opt("--key-file");
if (!keyFile && !process.env.DAYTONA_API_KEY) usage("give --key-file or set DAYTONA_API_KEY");
const probeZone = opt("--probe-zone")?.toLowerCase();
if (!probeZone || !HOSTNAME.test(probeZone)) usage("--probe-zone must be a DNS zone name");
const publicName = (opt("--public-name") ?? "example.com").toLowerCase();
if (!HOSTNAME.test(publicName)) usage("--public-name must be a DNS name");
const includeDomain = flag("--include-domain-mode");
const requireSudo = flag("--require-sudo");
const domainAllow = opt("--domain-allow")?.toLowerCase();
const allowAddress = opt("--allow-address");
const only = opt("--only") as EgressClass | undefined;
const outFile = opt("--out");
let forwardLabels: number;
try {
  forwardLabels = parseForwardLabels(opt("--forward-labels"));
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
const runId = makeRunId(randomBytes(10));

const ALL: EgressClass[] = ["none", "deny-all-except-proxy", "proxy-domain-filtered"];
if (only !== undefined && !ALL.includes(only)) usage(`--only must be one of ${ALL.join(", ")}`);
const classes = ALL.filter((c) =>
  only ? c === only : c !== "proxy-domain-filtered" || includeDomain,
);
if (only === "proxy-domain-filtered" && !includeDomain) {
  usage("proxy-domain-filtered needs --include-domain-mode");
}
if (classes.includes("deny-all-except-proxy")) {
  const m = allowAddress ? IPV4.exec(allowAddress) : null;
  if (!m || m.slice(1).some((o) => Number(o) > 255))
    usage("--allow-address must be an IPv4 address");
  if (allowAddress === PUBLIC_IP || (RESOLVERS as readonly string[]).includes(allowAddress!)) {
    usage(
      `--allow-address must differ from the probe targets (${PUBLIC_IP}, ${RESOLVERS.join(", ")})`,
    );
  }
}
if (classes.includes("proxy-domain-filtered")) {
  if (!domainAllow || !HOSTNAME.test(domainAllow)) usage("--domain-allow must be a DNS name");
  if (domainAllow === publicName) usage("--domain-allow must differ from --public-name");
}

/** How the next sandbox is created: the provider's own `none` path, or a substituted setting. */
let nextSetting: Record<string, unknown> | undefined;
class ProbeProvider extends DaytonaProvider {
  override buildCreateBody(spec: Parameters<DaytonaProvider["buildCreateBody"]>[0]) {
    const body = super.buildCreateBody(spec);
    if (nextSetting) {
      delete body.networkBlockAll;
      Object.assign(body, nextSetting);
    }
    return body;
  }
}

const usageRecords: UsageRecord[] = [];
const provider = new ProbeProvider({
  apiKey: keyFile ? { file: keyFile } : { env: "DAYTONA_API_KEY" },
  fleet: FLEET,
  maxLive: 1,
  runId: `egress-${Date.now().toString(36)}`,
  onUsage: (r) => usageRecords.push(r),
});

const dec = new TextDecoder();
async function run(id: string, a: string[], seconds: number): Promise<string> {
  const { execId } = await provider.exec.start(id, { argv: a, timeoutSeconds: seconds });
  for (;;) {
    const st = await provider.exec.status(id, execId);
    if (st.state !== "running") break;
    await Bun.sleep(400);
  }
  const logs = await provider.exec.logs(id, execId, { fromOffset: 0, maxBytes: 256 * 1024 });
  return dec.decode(logs.bytes);
}

async function probeClass(cls: EgressClass, classIndex: number): Promise<ClassReport> {
  const tag = cls === "none" ? "n" : cls === "deny-all-except-proxy" ? "s" : "d";
  const randomLabel = `tt${randomBytes(6).toString("hex")}${tag}`;
  let allowed: string | undefined;
  nextSetting = undefined;
  if (cls === "deny-all-except-proxy") {
    allowed = allowAddress;
    nextSetting = networkSettingFor({ host: allowed!, addresses: [allowed!] }, "address");
  } else if (cls === "proxy-domain-filtered") {
    allowed = domainAllow;
    nextSetting = networkSettingFor({ host: allowed! }, "domain");
  }
  const h = await provider.create({
    name: `egress-${cls}`,
    labels: { "turntable-egress-probe": "1" },
    ttlSeconds: 15 * 60,
    // `none` goes through the provider's own egress path (networkBlockAll); the other two replace
    // the setting with exactly what the provider would send for a proxy endpoint.
    network: { egress: cls === "none" ? "none" : "open" },
  });
  try {
    const route = await run(h.id, ["cat", "/proc/net/route"], 20);
    const gateway = parseGatewayFromProcNetRoute(route);
    console.log(`[${cls}] sandbox up; gateway ${gateway ?? "NOT FOUND"}`);
    const identity = parseIdentityOutput(await run(h.id, [...IDENTITY_ARGV], 20)) ?? undefined;
    console.log(`[${cls}] identity ${JSON.stringify(identity ?? "unreadable")}`);
    const plan = buildProbePlan({
      cls,
      publicName,
      publicIp: PUBLIC_IP,
      resolvers: RESOLVERS,
      probeZone: probeZone!,
      randomLabel,
      gateway,
      spoofHost: domainAllow ?? publicName,
      ...(allowed ? { allowed } : {}),
    });
    const sentAt = new Date().toISOString();
    // Class k uses indexes k*N..k*N+N-1 so no name repeats across classes (no resolver cache hit).
    const firstIndex = classIndex * forwardLabels;
    const burstNames = forwardLabelNames(runId, forwardLabels, probeZone!, firstIndex);
    const out = await run(
      h.id,
      [
        "node",
        "-e",
        SANDBOX_RUNNER_JS,
        JSON.stringify({
          timeoutMs: 8000,
          totalMs: 280000,
          probes: plan.map((p) => p.run),
          burst: buildBurst(burstNames),
        }),
      ],
      330,
    );
    const b = parseBurstOutput(out);
    const forwardCheck: ForwardCheck = {
      prefix: `eprobe-${runId}-`,
      n: forwardLabels,
      firstIndex,
      firstSentAt: b?.first ?? null,
      lastSentAt: b?.last ?? null,
      sentUdp: b?.sentUdp ?? 0,
      sentTcp: b?.sentTcp ?? 0,
      verdict: "inconclusive",
    };
    const raws = parseRunnerOutput(out, plan);
    const probes = plan.map((p) => reportProbe(cls, p, raws.get(p.id)!));
    const names = [...new Set(plan.flatMap((p) => (p.forwardedName ? [p.forwardedName] : [])))];
    return {
      class: cls,
      forwardedQueries: names.map((name) => ({ name, sentAt })),
      forwardCheck,
      probes,
      ...(identity ? { identity } : {}),
    };
  } finally {
    await provider.destroy(h.id).catch((e) => console.error(`destroy failed: ${String(e)}`));
  }
}

await provider.healthcheck();
const existing = await provider.count({});
if (existing > 0) {
  console.error(`refusing to start: ${existing} sandbox(es) of fleet ${FLEET} already exist`);
  process.exit(3);
}

const reports: ClassReport[] = [];
let leftover = 0;
try {
  for (const [i, cls] of classes.entries()) reports.push(await probeClass(cls, i)); // one sandbox at a time
} finally {
  leftover = await provider.count({});
  if (leftover > 0) {
    await provider.destroyByLabels({ [FLEET]: "1" });
    leftover = await provider.count({});
  }
}

const seconds = usageRecords.reduce((n, r) => n + r.seconds, 0);
const sudoFailed = requireSudo && reports.some((r) => !identityMeetsRequirement(r.identity));
const code = exitCodeFor(reports) || (sudoFailed ? 4 : 0);
const full = {
  generatedAt: new Date().toISOString(),
  probeZone,
  forwardLabels,
  runId,
  sandboxes: usageRecords.length,
  sandboxMinutes: Number((seconds / 60).toFixed(1)),
  sandboxesLeft: leftover,
  exitCode: leftover > 0 ? 3 : code,
  reports,
};
const json = JSON.stringify(full, null, 2);
if (outFile) writeFileSync(outFile, json + "\n");
console.log(json);
console.log("");
for (const r of reports) {
  const leaks = r.probes.filter((p) => p.verdict === "LEAK").map((p) => p.id);
  const inc = r.probes.filter((p) => p.verdict === "inconclusive").map((p) => p.id);
  console.log(
    `${r.class}: ${r.probes.length} probes, LEAK [${leaks.join(", ")}], inconclusive [${inc.join(", ")}]; identity ${JSON.stringify(r.identity ?? null)}`,
  );
}
console.log(
  `sandbox-seconds: ${seconds} = ${(seconds / 60).toFixed(1)} sandbox-minutes (${usageRecords.length} sandboxes); left behind: ${leftover}`,
);
console.log("");
console.log("NEXT STEP, forwarded-query check (this script cannot see your nameserver's log):");
console.log(`  look in the query log of the authoritative NS for ${probeZone} for these names.`);
console.log(
  "  A name that appears there was FORWARDED upstream from the sandbox: query names are an exfil channel for that class.",
);
for (const r of reports) {
  for (const q of r.forwardedQueries)
    console.log(`  [${r.class}] ${q.name}  (sent from ${q.sentAt}, within about 5 minutes after)`);
}
console.log("");
console.log(
  "ANALYTICS CHECK (sampled dataset, e.g. the zone's DNS analytics such as dnsAnalyticsAdaptiveGroups):",
);
for (const r of reports) {
  if (r.forwardCheck) for (const l of renderForwardCheck(r.class, r.forwardCheck)) console.log(l);
}
console.log(
  "  Record the result with: --render <report.json> --analytics-result <result.json> [--out <report.json>]",
);
process.exit(leftover > 0 ? 3 : code);
