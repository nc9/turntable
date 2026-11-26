// DNS for the control plane (issue: event loop stalls). Resolution never uses getaddrinfo
// (`dns.lookup`, also what Bun's fetch uses): on a container with a slow resolver it can block the
// main thread. This module asks the nameservers from resolv.conf through the async c-ares
// `Resolver` (resolve4 + resolve6), with an explicit timeout and tries, and no fallback: when the
// resolver does not answer, the request fails.
//
// c-ares skips /etc/hosts and the search domains, so a name is first checked against: IP literals
// (the caller), `localhost` and `*.localhost`, then the hosts file. Only then DNS.
import { Resolver as CaresResolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export interface DnsResolverOptions {
  /** Per-try timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Tries per server. Default 2. */
  tries?: number;
  /** Nameservers. Default: the ones in resolv.conf (the c-ares default). */
  servers?: string[];
  /** Hosts file. Default /etc/hosts. */
  hostsPath?: string;
  /** Cache cap in seconds. Default 60. */
  maxTtlSeconds?: number;
  /** Cache cap in entries. Default 512. */
  maxEntries?: number;
  now?: () => number;
}

export type DnsResolve = (hostname: string) => Promise<string[]>;

interface Answer {
  address: string;
  ttl: number;
}

function parseHosts(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [addr, ...names] = line.split(/\s+/);
    if (!addr || isIP(addr.replace(/%.*/, "")) === 0) continue;
    for (const n of names) {
      const k = n.toLowerCase();
      const list = out.get(k) ?? [];
      list.push(addr);
      out.set(k, list);
    }
  }
  return out;
}

const isMissing = (e: unknown): boolean => {
  const c = (e as { code?: string } | null)?.code;
  return c === "ENODATA" || c === "ENOTFOUND";
};

export function createDnsResolver(o: DnsResolverOptions = {}): DnsResolve {
  const resolver = new CaresResolver({ timeout: o.timeoutMs ?? 2000, tries: o.tries ?? 2 });
  if (o.servers) resolver.setServers(o.servers);
  const now = o.now ?? Date.now;
  const maxTtl = (o.maxTtlSeconds ?? 60) * 1000;
  const maxEntries = o.maxEntries ?? 512;
  const hostsPath = o.hostsPath ?? "/etc/hosts";
  const cache = new Map<string, { addresses: string[]; expires: number }>();

  const fromHosts = (h: string): string[] => {
    try {
      return parseHosts(readFileSync(hostsPath, "utf8")).get(h) ?? [];
    } catch {
      return [];
    }
  };

  return async (hostname) => {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (h === "localhost" || h.endsWith(".localhost")) return ["127.0.0.1", "::1"];
    const hit = cache.get(h);
    if (hit && hit.expires > now()) return [...hit.addresses];
    cache.delete(h);
    const local = fromHosts(h);
    if (local.length > 0) return local;

    const [r4, r6] = await Promise.allSettled([
      resolver.resolve4(h, { ttl: true }) as Promise<Answer[]>,
      resolver.resolve6(h, { ttl: true }) as Promise<Answer[]>,
    ]);
    const answers: Answer[] = [];
    for (const r of [r4, r6]) {
      if (r.status === "fulfilled") answers.push(...r.value);
      else if (!isMissing(r.reason) && r4.status === "rejected" && r6.status === "rejected")
        throw r.reason;
    }
    // One family failing hard while the other answered is fine; both missing is "no answer".
    const addresses = answers.map((a) => a.address);
    if (addresses.length > 0) {
      const ttl = Math.min(maxTtl, Math.min(...answers.map((a) => a.ttl)) * 1000);
      if (ttl > 0) {
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(h, { addresses, expires: now() + ttl });
      }
    }
    return addresses;
  };
}
