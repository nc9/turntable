// Proof for the hosted ~30 s event loop stalls: how much does the loop lag while the resolver
// never answers? Measures `dns.promises.lookup` (getaddrinfo) against c-ares `Resolver.resolve4`,
// prints both, and asserts only that c-ares keeps the loop ticking. The lookup half needs a private
// network namespace (unshare, python3 to bring lo up); without them it reports SKIPPED.
import { expect, test } from "bun:test";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures/dns-lag-child.ts");

/** Max timer lateness (ms) of a 50 ms interval while `work` runs. */
async function maxDrift(work: () => Promise<unknown>): Promise<{ drift: number; ms: number }> {
  let last = performance.now();
  let drift = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    drift = Math.max(drift, t - last - 50);
    last = t;
  }, 50);
  const t0 = performance.now();
  await work().catch(() => {});
  const ms = performance.now() - t0;
  clearInterval(timer);
  return { drift, ms };
}

async function blackhole(): Promise<{ port: number; close: () => void }> {
  const s = dgram.createSocket("udp4");
  s.on("message", () => {});
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
  return { port: s.address().port, close: () => s.close() };
}

test("resolve4 against an unresponsive server times out without stalling the event loop", async () => {
  const bh = await blackhole();
  try {
    const r = new dns.Resolver({ timeout: 500, tries: 2 });
    r.setServers([`127.0.0.1:${bh.port}`]);
    const { drift, ms } = await maxDrift(() => r.resolve4("blackhole.example.test"));
    console.log(`DNS-LAG resolve4: max drift ${Math.round(drift)} ms over ${Math.round(ms)} ms`);
    expect(ms).toBeGreaterThan(400); // it really waited for the timeout
    expect(drift).toBeLessThan(500);
  } finally {
    bh.close();
  }
}, 20_000);

async function inNamespace(mode: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dns-lag-"));
  const resolv = join(dir, "resolv.conf");
  writeFileSync(resolv, "nameserver 127.0.0.1\noptions timeout:5 attempts:2\n");
  const lo =
    'python3 -c "import socket,fcntl,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);' +
    "fcntl.ioctl(s,0x8914,struct.pack('16sH14x',b'lo',1))\"";
  const script = `${lo} && mount --bind ${resolv} /etc/resolv.conf && exec ${process.execPath} ${CHILD} ${mode}`;
  const p = Bun.spawn(["unshare", "-rmn", "sh", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => p.kill(), 90_000);
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  clearTimeout(timeout);
  await p.exited;
  const line = out.trim().split("\n").pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`no result: ${err.slice(0, 300)}`);
  return line;
}

test("lookup (getaddrinfo) vs resolve4 lag under an unresponsive system resolver", async () => {
  if (process.platform !== "linux") return console.log("DNS-LAG lookup: SKIPPED (not linux)");
  for (const mode of ["lookup", "resolve4"]) {
    try {
      console.log(`DNS-LAG ${await inNamespace(mode)}`);
    } catch (e) {
      console.log(`DNS-LAG ${mode}: SKIPPED (${(e as Error).message})`);
    }
  }
}, 240_000);
