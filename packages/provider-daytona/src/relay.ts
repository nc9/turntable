// The relay a proxied Daytona sandbox runs. Tools inside the sandbox speak plain HTTP to
// 127.0.0.1 (so any tool with a proxy setting works, whether or not it can talk to an HTTPS
// proxy); the relay carries each connection over TLS to the secrets proxy's public endpoint and
// checks the endpoint's certificate against its name. It holds no credential: the per-attempt
// credential stays in the tools' proxy URL, as with Docker. Node is in the sandbox image because
// act needs it.

/** Port the relay listens on, on the sandbox's loopback. */
export const RELAY_PORT = 3128;

/**
 * argv after `-e`: listen port, endpoint host or address, endpoint port, TLS server name, ttl
 * seconds, optional CA file (tests only: production verifies against the system roots). This text
 * runs inside the sandbox, not in the control plane.
 */
export const RELAY_JS = `
const { createServer } = require("net");
const { connect } = require("tls");
const { readFileSync } = require("fs");
const [lp, host, port, name, ttl, caFile] = process.argv.slice(1);
const ca = caFile ? readFileSync(caFile) : undefined;
createServer((c) => {
  c.pause();
  const u = connect({ host, port: Number(port), servername: name, ca });
  const k = () => { c.destroy(); u.destroy(); };
  c.on("error", k); u.on("error", k); c.on("close", k); u.on("close", k);
  u.on("secureConnect", () => { c.pipe(u); u.pipe(c); c.resume(); });
}).listen(Number(lp), "127.0.0.1", () => console.log("ready"));
setTimeout(() => process.exit(0), Number(ttl) * 1000);
`;

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isIpv4 = (s: string): boolean => {
  const m = IPV4.exec(s);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
};

export type NetworkSetting = { networkAllowList: string } | { domainAllowList: string };

/**
 * How the sandbox is confined to the proxy endpoint. `address`: an allow list of the endpoint's
 * stable addresses (a hard refusal, DNS dropped, nothing to resolve). `domain`: a domain list of
 * its one name, which Daytona enforces on the TLS server name whatever the destination address:
 * weaker, so callers only ask for it when the operator has opted in. Anything malformed is
 * refused here, before a request is made.
 */
export function networkSettingFor(
  endpoint: {
    host: string;
    tlsName?: string | undefined;
    addresses?: readonly string[] | undefined;
  },
  mode: "address" | "domain" = "address",
): NetworkSetting {
  const name = (endpoint.tlsName ?? endpoint.host).toLowerCase();
  if (mode === "address") {
    if (!endpoint.addresses || endpoint.addresses.length === 0) {
      throw new Error("an address allow list needs the endpoint's addresses");
    }
    if (endpoint.addresses.length > 10) throw new Error("at most 10 endpoint addresses");
    for (const a of endpoint.addresses) {
      if (!isIpv4(a)) throw new Error(`endpoint address ${a} is not an IPv4 address`);
    }
    return { networkAllowList: endpoint.addresses.map((a) => `${a}/32`).join(",") };
  }
  if (!HOSTNAME.test(name) || isIpv4(name) || /^\d+$/.test(name.split(".").at(-1) ?? "")) {
    throw new Error("the endpoint needs a DNS name, not an address");
  }
  return { domainAllowList: name };
}

/**
 * What a proxied sandbox must not be able to reach, for the caller to check from inside: a public
 * address on the proxy's own port (an allow list wider than intended), a private address and the
 * metadata address. The sandbox's gateway is not here: Daytona answers on it under every setting.
 */
export function mustNotReachFor(port: number, addresses: readonly string[] | undefined): string[] {
  const listed = new Set(addresses ?? []);
  const other = ["8.8.8.8", "9.9.9.9", "208.67.222.222"].find((a) => !listed.has(a)) ?? "8.8.8.8";
  return [
    `${other}:${port}`,
    `${other}:80`,
    "10.0.0.1:80",
    "192.168.0.1:80",
    "172.16.0.1:80",
    "169.254.169.254:80",
  ];
}
