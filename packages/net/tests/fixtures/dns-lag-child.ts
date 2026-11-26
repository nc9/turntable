// Child of dns-lag.test.ts. Runs inside a private network namespace whose resolv.conf names a
// nameserver on 127.0.0.1:53 that receives queries and never answers. Prints one JSON line.
import dgram from "node:dgram";
import dns from "node:dns/promises";

const mode = process.argv[2] ?? "lookup";
const sock = dgram.createSocket("udp4");
sock.on("message", () => {}); // swallow every query
await new Promise<void>((res) => sock.bind(53, "127.0.0.1", () => res()));

let last = performance.now();
let maxDrift = 0;
const timer = setInterval(() => {
  const t = performance.now();
  maxDrift = Math.max(maxDrift, t - last - 50);
  last = t;
}, 50);

const t0 = performance.now();
let outcome = "";
try {
  if (mode === "lookup") {
    await dns.lookup("blackhole.example.test", { all: true, verbatim: true });
  } else {
    // default servers come from resolv.conf, as in production
    await new dns.Resolver({ timeout: 1000, tries: 2 }).resolve4("blackhole.example.test");
  }
  outcome = "resolved";
} catch (e) {
  outcome = (e as { code?: string }).code ?? "error";
}
clearInterval(timer);
const ms = Math.round(performance.now() - t0);
console.log(JSON.stringify({ mode, outcome, ms, maxDriftMs: Math.round(maxDrift) }));
sock.close();
