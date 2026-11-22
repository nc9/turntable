// A short spike for docs/design/daytona-proxy.mdx: what Daytona's per-sandbox network allow lists
// really do, measured from inside a sandbox. Run by hand from one machine, under the account
// rules in policy.ts (our label and name prefix, at most 2 live, short TTL, no snapshots, delete in
// finally, wait while the owner's CI holds many sandboxes).
//
//   bun run packages/provider-daytona/scripts/proxy-spike.ts <key-file>
//
// The key is read in this process from the file and never printed or put on a command line. The
// script refuses to start if any of our own sandboxes exist, and reports sandbox-minutes at the end.
import { DaytonaProvider, OWN_LABEL, OWN_LABEL_VALUE, type UsageRecord } from "../src/index";

const keyFile = process.argv[2];
if (!keyFile) {
  console.error("usage: proxy-spike.ts <key-file>");
  process.exit(2);
}

/** How the next sandbox is created: one of the three mutually exclusive network settings. */
type Net = { allowList: string } | { domains: string } | { blockAll: true } | { open: true };
let nextNet: Net = { open: true };

class SpikeProvider extends DaytonaProvider {
  override buildCreateBody(spec: Parameters<DaytonaProvider["buildCreateBody"]>[0]) {
    const body = super.buildCreateBody(spec);
    delete body.networkBlockAll;
    const n = nextNet;
    if ("allowList" in n) body.networkAllowList = n.allowList;
    else if ("domains" in n) body.domainAllowList = n.domains;
    else if ("blockAll" in n) body.networkBlockAll = true;
    return body;
  }
}

const usage: UsageRecord[] = [];
const provider = new SpikeProvider({
  apiKey: { file: keyFile },
  maxLive: 2,
  runId: `spike-${Date.now().toString(36)}`,
  onUsage: (r) => usage.push(r),
});

await provider.healthcheck();
const existing = await provider.count({});
if (existing > 0) {
  console.error(
    `refusing to start: ${existing} sandbox(es) labelled ${OWN_LABEL}=${OWN_LABEL_VALUE} already exist`,
  );
  process.exit(1);
}

const dec = new TextDecoder();
async function sh(id: string, script: string, seconds = 60): Promise<string> {
  const { execId } = await provider.exec.start(id, {
    argv: ["sh", "-c", script],
    timeoutSeconds: seconds,
  });
  for (;;) {
    const st = await provider.exec.status(id, execId);
    if (st.state !== "running") break;
    await Bun.sleep(300);
  }
  const logs = await provider.exec.logs(id, execId, { fromOffset: 0, maxBytes: 64 * 1024 });
  return dec.decode(logs.bytes).trim();
}

/** One curl: prints the exit code, http code and curl's own error text. */
const curl = (target: string, extra = ""): string =>
  `echo "--- curl ${extra} ${target}"; out=$(curl -sS -m 8 ${extra} -o /dev/null -w '%{http_code}' ${target} 2>&1); echo "exit=$? out=$out"`;

const sections: string[] = [];
const note = (title: string, body: string): void => {
  const t = `### ${title}\n${body}\n`;
  sections.push(t);
  console.log(t);
};

type Api = { json: (m: string, p: string, i?: unknown) => Promise<unknown> };
const api = (provider as unknown as { api: Api }).api;

/**
 * The org's container vCPU usage in region us must leave room for ours (the quota is 250; stay
 * under 200), because another team runs a large benchmark in the same org. Waits, never creates
 * while it is over.
 */
let orgId: string | undefined;
async function waitForOrgQuota(vcpu: number, limit = 200): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (!orgId) {
      const list = (await api.json("GET", "/sandbox", { query: { limit: 1 } })) as {
        items?: { organizationId?: string }[];
      };
      orgId = list.items?.[0]?.organizationId;
    }
    if (!orgId) {
      console.log("no organization id found; refusing to create without the usage check");
      process.exit(1);
    }
    const u = (await api.json("GET", `/organizations/${encodeURIComponent(orgId)}/usage`)) as {
      regionUsage?: { regionId?: string; sandboxClass?: string; currentCpuUsage?: number }[];
    };
    const row = u.regionUsage?.find((r) => r.regionId === "us" && r.sandboxClass === "container");
    const cpu = row?.currentCpuUsage;
    if (cpu === undefined) {
      console.log("usage reply has no us/container row; refusing to create without the check");
      process.exit(1);
    }
    if (cpu + vcpu <= limit) {
      console.log(`org usage check: ${cpu} vCPU in use, +${vcpu} <= ${limit}`);
      return;
    }
    if (Date.now() > deadline) {
      console.log(`org usage stayed over the limit (${cpu} + ${vcpu} > ${limit}); giving up`);
      process.exit(1);
    }
    console.log(`org usage ${cpu} + ${vcpu} > ${limit}; waiting`);
    await Bun.sleep(15_000);
  }
}

async function withSandbox(label: string, net: Net, f: (id: string) => Promise<void>) {
  await waitForOrgQuota(1);
  nextNet = net;
  const h = await provider.create({
    name: `spike-${label}`,
    labels: { "longshore-spike": "1" },
    ttlSeconds: 900,
    network: { egress: "open" },
  });
  try {
    await f(h.id);
  } finally {
    await provider.destroy(h.id).catch((e) => console.error(`destroy failed: ${String(e)}`));
  }
}

const ENV_PROBE = `
for t in curl node python3 bash nc getent dig nslookup; do
  if command -v $t >/dev/null 2>&1; then echo "$t: yes"; else echo "$t: no"; fi
done
echo "--- resolv.conf"; cat /etc/resolv.conf 2>&1 | grep -v '^#' | head -5
echo "--- default route"; (ip route 2>/dev/null || route -n 2>/dev/null || cat /proc/net/route) | head -4
echo "--- whoami"; id -un
`;

const extra = ["extra", "extra2", "extra3", "extra4"].includes(process.argv[3] ?? "");
const only4 = process.argv[3] === "extra4";
const only3 = process.argv[3] === "extra3";
const only2 = process.argv[3] === "extra2";
if (extra) {
  if (only4) {
    const through = [
      'gw=$(ip route | awk "/^default/ {print \\$3}")',
      'echo "--- through the gateway proxy to example.com"; out=$(curl -sS -m 8 -x http://$gw:18080 -o /dev/null -w "%{http_code}" https://example.com/ 2>&1); echo "exit=$? out=$out"',
      'echo "--- through the gateway proxy to a bare address"; out=$(curl -sS -m 8 -x http://$gw:18080 -k -o /dev/null -w "%{http_code}" https://8.8.8.8/ 2>&1); echo "exit=$? out=$out"',
      'echo "--- through the gateway proxy, plain http"; out=$(curl -sS -m 8 -x http://$gw:18080 -o /dev/null -w "%{http_code}" http://example.com/ 2>&1); echo "exit=$? out=$out"',
      'echo "--- ssh banner from the gateway:22"; (timeout 3 bash -c "exec 3<>/dev/tcp/$gw/22 && head -c 40 <&3") 2>&1 | head -2; echo',
    ].join("\n");
    try {
      await withSandbox("allow-via-gw", { allowList: "1.1.1.1/32" }, async (id) => {
        note("allow list 1.1.1.1/32: is the gateway proxy a way out?", await sh(id, through));
      });
      await withSandbox("block-via-gw", { blockAll: true }, async (id) => {
        note(
          "networkBlockAll: is the gateway proxy a way out?",
          await sh(id, through + "\n" + curl("https://1.1.1.1/")),
        );
      });
    } finally {
      const left = await provider.count({});
      const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
      const seconds = usage.reduce((n, r) => n + r.seconds, 0);
      console.log(
        `sandboxes: ${usage.length}; sandbox-seconds ${seconds} (${(seconds / 60).toFixed(1)} min); swept ${swept}; remaining ${await provider.count({})}`,
      );
    }
    process.exit(0);
  }
  if (only3) {
    try {
      await withSandbox("allow-gw", { allowList: "1.1.1.1/32" }, async (id) => {
        note(
          "the sandbox's own gateway and Daytona's resolver under an allow list (1.1.1.1/32)",
          await sh(
            id,
            [
              'gw=$(ip route | awk "/^default/ {print \\$3}"); echo "gateway=$gw"',
              'for p in 18080 80 443 22 2280; do (timeout 3 bash -c "exec 3<>/dev/tcp/$gw/$p" && echo "gateway tcp $p: connected") 2>&1 | head -1; done',
              curl("http://172.20.0.1:18080/", ""),
              'echo "--- 100.65.160.1 (resolver in resolv.conf) udp 53"; (timeout 3 bash -c "exec 3<>/dev/udp/100.65.160.1/53 && echo sent") 2>&1; echo "exit=$?"',
              'echo "--- 100.65.160.1 tcp 53"; (timeout 3 bash -c "exec 3<>/dev/tcp/100.65.160.1/53 && echo connected") 2>&1; echo "exit=$?"',
              'echo "--- listed address, a port nothing serves (1.1.1.1:81)"; (timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/81 && echo connected") 2>&1; echo "exit=$?"',
              'echo "--- unlisted, same port (8.8.8.8:81)"; (timeout 5 bash -c "exec 3<>/dev/tcp/8.8.8.8/81 && echo connected") 2>&1; echo "exit=$?"',
            ].join("\n"),
          ),
        );
      });
    } finally {
      const left = await provider.count({});
      const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
      const seconds = usage.reduce((n, r) => n + r.seconds, 0);
      console.log(
        `sandboxes: ${usage.length}; sandbox-seconds ${seconds} (${(seconds / 60).toFixed(1)} min); swept ${swept}; remaining ${await provider.count({})}`,
      );
    }
    process.exit(0);
  }
  if (only2) {
    try {
      await withSandbox("domain3", { domains: "example.com" }, async (id) => {
        note(
          "domain allow list (example.com): can the allowed name be spoofed to reach another address, and is non-TLS traffic let through",
          await sh(
            id,
            [
              'echo "--- allowed SNI sent to another address (1.1.1.1), direct"; out=$(curl -sS -m 8 --noproxy "*" -k --resolve example.com:443:1.1.1.1 -o /dev/null -w "%{http_code}" https://example.com/ 2>&1); echo "exit=$? out=$out"',
              'echo "--- allowed SNI sent to another address (8.8.8.8), direct"; out=$(curl -sS -m 8 --noproxy "*" -k --resolve example.com:443:8.8.8.8 -o /dev/null -w "%{http_code}" https://example.com/ 2>&1); echo "exit=$? out=$out"',
              'echo "--- plain http to 1.1.1.1, direct"; out=$(curl -sS -m 8 --noproxy "*" -o /dev/null -w "%{http_code}" http://1.1.1.1/ 2>&1); echo "exit=$? out=$out"',
              'echo "--- plain http to example.com, direct"; out=$(curl -sS -m 8 --noproxy "*" -o /dev/null -w "%{http_code}" http://example.com/ 2>&1); echo "exit=$? out=$out"',
              'echo "--- tcp 1.1.1.1:80, no TLS, raw"; (timeout 4 bash -c \'exec 3<>/dev/tcp/1.1.1.1/80 && printf "GET / HTTP/1.0\\r\\nHost: example.com\\r\\n\\r\\n" >&3 && head -c 60 <&3\') 2>&1; echo "exit=$?"',
            ].join("\n"),
          ),
        );
      });
    } finally {
      const left = await provider.count({});
      const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
      const seconds = usage.reduce((n, r) => n + r.seconds, 0);
      console.log(
        `sandboxes: ${usage.length}; sandbox-seconds ${seconds} (${(seconds / 60).toFixed(1)} min); swept ${swept}; remaining ${await provider.count({})}`,
      );
    }
    process.exit(0);
  }
  try {
    // The questions the first run left open: IPv6 under an IPv4 allow list, and how a domain list
    // is enforced (a forward proxy set up through the environment, or the firewall).
    await withSandbox("allow6", { allowList: "1.1.1.1/32" }, async (id) => {
      note(
        "IPv6 under an IPv4 allow list (1.1.1.1/32)",
        await sh(
          id,
          [
            'echo "--- ip -6 addr"; (ip -6 addr 2>&1 | grep -E "inet6" | grep -v "scope host" | head -3); echo',
            'echo "--- ip -6 route"; ip -6 route 2>&1 | head -3',
            curl("https://[2606:4700:4700::1111]/", "-g -6"),
            curl("https://[2001:4860:4860::8888]/", "-g -6"),
            curl("https://example.com/", "-6"),
            curl("https://example.com/", "-4"),
            'echo "--- env proxies"; env | grep -i -E "^(https?|no|all)_proxy=" | sed -E "s#//[^@/]*@#//<credential>@#" | cut -c1-120',
          ].join("\n"),
        ),
      );
    });
    await withSandbox("domain2", { domains: "example.com" }, async (id) => {
      note(
        "domain allow list (example.com): environment, then direct connections that skip the proxy",
        await sh(
          id,
          [
            'echo "--- env proxies"; env | grep -i -E "^(https?|no|all)_proxy=" | sed -E "s#//[^@/]*@#//<credential>@#" | cut -c1-120',
            'echo "--- with the proxy"; ' + curl("https://example.com/"),
            curl("https://example.com/", "--noproxy '*' -4"),
            curl("https://example.com/", "--noproxy '*' -6"),
            curl("https://1.1.1.1/", "--noproxy '*' -4"),
            curl("https://8.8.8.8/", "--noproxy '*' -4"),
            curl("https://[2606:4700:4700::1111]/", "--noproxy '*' -g -6"),
            curl("https://one.one.one.one/", "--noproxy '*'"),
            'echo "--- address of example.com, direct, SNI example.com"; ip4=$(getent ahostsv4 example.com | head -1 | cut -d" " -f1); echo "v4=$ip4"; out=$(curl -sS -m 8 --noproxy "*" -k --resolve example.com:443:$ip4 -o /dev/null -w "%{http_code}" https://example.com/ 2>&1); echo "exit=$? out=$out"',
            'echo "--- address of example.com, direct, no name"; ip4=$(getent ahostsv4 example.com | head -1 | cut -d" " -f1); out=$(curl -sS -m 8 --noproxy "*" -k -o /dev/null -w "%{http_code}" https://$ip4/ 2>&1); echo "exit=$? out=$out"',
          ].join("\n"),
        ),
      );
    });
  } finally {
    const left = await provider.count({});
    const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
    const seconds = usage.reduce((n, r) => n + r.seconds, 0);
    console.log(
      `sandboxes: ${usage.length}; sandbox-seconds ${seconds} (${(seconds / 60).toFixed(1)} min); swept ${swept}; remaining ${await provider.count({})}`,
    );
  }
  process.exit(0);
}

try {
  // Sandbox 1: an allow list at create time, then changed on the running sandbox.
  await withSandbox("allow", { allowList: "1.1.1.1/32" }, async (id) => {
    note("Image tools, resolver and route (allow list 1.1.1.1/32)", await sh(id, ENV_PROBE));
    note(
      "(a) the allowed address",
      await sh(
        id,
        [
          curl("https://1.1.1.1/"),
          curl("https://one.one.one.one/", "--resolve one.one.one.one:443:1.1.1.1"),
        ].join("\n"),
      ),
    );
    note(
      "(b) a non-listed host name",
      await sh(id, [curl("https://example.com/"), curl("http://example.com/")].join("\n")),
    );
    note(
      "(c) non-listed IP literals (public, private ranges, metadata, the resolver)",
      await sh(
        id,
        [
          "https://8.8.8.8/",
          "https://9.9.9.9/",
          "http://10.0.0.1/",
          "http://172.16.0.1/",
          "http://192.168.0.1/",
          "http://169.254.169.254/",
          "http://100.64.0.1/",
        ]
          .map((t) => curl(t))
          .join("\n"),
      ),
    );
    note(
      "(d) DNS for names, through the system resolver and straight to resolvers",
      await sh(
        id,
        [
          'echo "--- getent example.com"; getent hosts example.com; echo "exit=$?"',
          'echo "--- getent one.one.one.one"; getent hosts one.one.one.one; echo "exit=$?"',
          `echo "--- udp 1.1.1.1:53 (listed)"; (timeout 3 bash -c 'exec 3<>/dev/udp/1.1.1.1/53 && echo sent') 2>&1; echo "exit=$?"`,
          `echo "--- tcp 8.8.8.8:53 (not listed)"; (timeout 3 bash -c 'exec 3<>/dev/tcp/8.8.8.8/53 && echo connected') 2>&1; echo "exit=$?"`,
        ].join("\n"),
      ),
    );
    // (e) change the list on the running sandbox, and look for a window.
    const before = await sh(id, curl("https://9.9.9.9/"));
    const t0 = Date.now();
    let update = "";
    try {
      const api = (
        provider as unknown as {
          api: { json: (m: string, p: string, i?: unknown) => Promise<unknown> };
        }
      ).api;
      const res = await api.json("POST", `/sandbox/${encodeURIComponent(id)}/network-settings`, {
        json: { networkAllowList: "9.9.9.9/32" },
        timeoutMs: 30_000,
      });
      update = `update ok in ${Date.now() - t0} ms: ${JSON.stringify(res).slice(0, 300)}`;
    } catch (e) {
      update = `update failed: ${(e as Error).message}`;
    }
    const after = await sh(
      id,
      [curl("https://9.9.9.9/"), curl("https://1.1.1.1/"), curl("https://example.com/")].join("\n"),
    );
    note(
      "(e) changing the allow list on the running sandbox",
      `before (9.9.9.9 not listed):\n${before}\n${update}\nafter (list is now 9.9.9.9/32):\n${after}`,
    );
  });

  // Sandbox 2: a domain allow list.
  await withSandbox("domain", { domains: "example.com" }, async (id) => {
    note(
      "domain allow list (example.com): name, its address, a SNI trick, other names",
      await sh(
        id,
        [
          curl("https://example.com/"),
          'ip=$(getent hosts example.com | head -1 | cut -d" " -f1); echo "example.com resolves to: $ip"',
          'ip=$(getent hosts example.com | head -1 | cut -d" " -f1); echo "--- by address, no name"; out=$(curl -sSk -m 8 -o /dev/null -w "%{http_code}" https://$ip/ 2>&1); echo "exit=$? out=$out"',
          curl("https://one.one.one.one/"),
          curl("https://1.1.1.1/"),
          'echo "--- SNI example.com sent to 1.1.1.1"; out=$(curl -sSk -m 8 --resolve example.com:443:1.1.1.1 -o /dev/null -w "%{http_code}" https://example.com/ 2>&1); echo "exit=$? out=$out"',
          'echo "--- getent one.one.one.one"; getent hosts one.one.one.one; echo "exit=$?"',
        ].join("\n"),
      ),
    );
  });

  // Sandbox 3 is not needed: a create with no setting shows the account default.
  await withSandbox("default", { open: true }, async (id) => {
    note(
      "no network setting (the account default)",
      await sh(id, [curl("https://example.com/"), curl("https://8.8.8.8/")].join("\n")),
    );
  });
} finally {
  const left = await provider.count({});
  const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
  const seconds = usage.reduce((n, r) => n + r.seconds, 0);
  console.log(
    `sandboxes: ${usage.length}; sandbox-seconds ${seconds} (${(seconds / 60).toFixed(1)} min); swept ${swept}; remaining ${await provider.count({})}`,
  );
}
