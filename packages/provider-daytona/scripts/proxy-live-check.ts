// The live check for the Daytona proxy path (docs/design/daytona-proxy.mdx): given a reachable
// secrets-proxy endpoint, it creates ONE deny-all-except-proxy sandbox and checks, from inside it,
// what the design promises:
//
//   1. direct egress is closed (the egress canary's public and metadata targets);
//   2. everything the provider says must not be reachable is closed (a public address on the
//      proxy's own port, private ranges, the metadata address);
//   3. the proxy is open through the relay, and answers 407 to a bad credential;
//   4. with a credential for a rule on that proxy, one request to a test upstream succeeds and,
//      optionally, the upstream's answer holds a marker proving the credential was injected.
//
// It goes through DaytonaProvider, so every account rule applies without being repeated here: the
// org CPU preflight, at most 2 live sandboxes, our label and name prefix, a TTL under 30 minutes,
// no snapshots. The sandbox is deleted in a finally, anything of ours that is left is swept by
// label, and sandbox-minutes are logged. The key is read in this process (from a file, or
// DAYTONA_API_KEY in ~/.secrets as live-check.ts does) and is never printed or put on a command
// line; the proxy credential goes into the sandbox as a file, never in an argv.
//
//   bun run packages/provider-daytona/scripts/proxy-live-check.ts \
//     --proxy-host proxy.example.com --proxy-port 8443 --tls-name proxy.example.com \
//     --addresses 203.0.113.10 \
//     [--credential-file cred.json --upstream https://echo.example.com/headers --expect marker] \
//     [--confine address|domain] [--key-file <path>] [--dry-run]
//
// `--dry-run` prints the sandbox create body and the planned checks and calls nothing: it does not
// read the key, does not reach Daytona and does not resolve the proxy.
//
// `cred.json` is `{"username": "...", "password": "...", "caPem": "..."}`: a per-attempt proxy
// credential, issued by the proxy for an attempt whose project has a rule for the upstream.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { SandboxSpec } from "@longshore/provider-sdk";
import {
  DaytonaProvider,
  OWN_LABEL,
  OWN_LABEL_VALUE,
  mustNotReachFor,
  type UsageRecord,
} from "../src/index";
import { isIpv4 } from "../src/relay";
import { readEnvFileVar } from "./env-file";

const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Options {
  host: string;
  port: number;
  tlsName: string;
  addresses: string[];
  confine: "address" | "domain";
  dryRun: boolean;
  keyFile: string | undefined;
  credentialFile: string | undefined;
  upstream: URL | undefined;
  expect: string | undefined;
}

/** Validates flags before anything is created or read. Throws a message for the operator. */
export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      "proxy-host": { type: "string" },
      "proxy-port": { type: "string" },
      "tls-name": { type: "string" },
      addresses: { type: "string" },
      confine: { type: "string", default: "address" },
      "key-file": { type: "string" },
      "credential-file": { type: "string" },
      upstream: { type: "string" },
      expect: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const host = values["proxy-host"]?.trim().toLowerCase();
  if (!host || (!HOST.test(host) && !isIpv4(host)))
    throw new Error("--proxy-host must be a host name or an IPv4 address");
  const port = Number(values["proxy-port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--proxy-port must be a port number");
  const tlsName = (values["tls-name"] ?? host).trim().toLowerCase();
  if (!HOST.test(tlsName) || isIpv4(tlsName))
    throw new Error("--tls-name must be a DNS name (the certificate's name)");
  const addresses = (values.addresses ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  for (const a of addresses)
    if (!isIpv4(a)) throw new Error(`--addresses: ${a} is not an IPv4 address`);
  if (addresses.length > 10) throw new Error("--addresses: at most 10");
  const confine = values.confine;
  if (confine !== "address" && confine !== "domain")
    throw new Error("--confine must be address or domain");
  if (confine === "address" && addresses.length === 0)
    throw new Error("--confine address needs --addresses (the proxy's stable IPv4 addresses)");
  let upstream: URL | undefined;
  if (values.upstream) {
    upstream = new URL(values.upstream);
    if (upstream.protocol !== "https:" || upstream.username || upstream.password)
      throw new Error("--upstream must be an https URL with no credentials in it");
  }
  if (values["credential-file"] && !upstream) throw new Error("--credential-file needs --upstream");
  if (upstream && !values["credential-file"]) throw new Error("--upstream needs --credential-file");
  if (values.expect && !upstream) throw new Error("--expect needs --upstream");
  return {
    host,
    port,
    tlsName,
    addresses,
    confine,
    dryRun: values["dry-run"] === true,
    keyFile: values["key-file"],
    credentialFile: values["credential-file"],
    upstream,
    expect: values.expect,
  };
}

export function specFor(o: Options): SandboxSpec {
  return {
    name: "proxy-live-check",
    labels: {},
    ttlSeconds: 15 * 60,
    network: {
      egress: o.confine === "domain" ? "proxy-domain-filtered" : "deny-all-except-proxy",
      proxy: {
        host: o.host,
        port: o.port,
        tlsName: o.tlsName,
        ...(o.addresses.length > 0 ? { addresses: o.addresses } : {}),
      },
    },
  } as SandboxSpec;
}

/** The checks, as sh scripts run inside the sandbox. The proxy credential is a file, not an argument. */
export const RELAY = "http://127.0.0.1:3128";
export const BAD_CREDENTIAL_CHECK = `curl -sS -m 15 -x ${RELAY} --proxy-user bad:bad -o /dev/null -w '%{http_connect}' https://example.com/ 2>/dev/null; true`;
export const INJECTED_CHECK = (upstream: string, expect: string | undefined): string =>
  [
    "set -e",
    `code=$(curl -sS -m 25 -x ${RELAY} --proxy-user "$(cat /tmp/longshore-proxy/auth)" --cacert /tmp/longshore-proxy/ca.pem -o /tmp/longshore-proxy/body -w '%{http_code}' '${upstream}' 2>/dev/null || true)`,
    'echo "status=$code"',
    ...(expect
      ? [
          `if grep -qF -- '${expect.replaceAll("'", "'\\''")}' /tmp/longshore-proxy/body; then echo "marker=present"; else echo "marker=absent"; fi`,
        ]
      : []),
    "rm -f /tmp/longshore-proxy/body",
  ].join("\n");

if (import.meta.main) {
  let o: Options;
  try {
    o = parseOptions(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const spec = specFor(o);

  if (o.dryRun) {
    // No key, no network: only the body the provider would send.
    const p = new DaytonaProvider({
      apiKey: () => "dry-run",
      allowDomainListConfinement: o.confine === "domain",
      runId: "dry-run",
    });
    const body = p.buildCreateBody(spec);
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          createBody: body,
          mustNotReach: mustNotReachFor(o.port, o.addresses),
          checks: [
            "direct egress closed (egress canary)",
            "must-not-reach targets closed",
            `proxy open through the relay at ${RELAY}, 407 for a bad credential`,
            ...(o.upstream
              ? [`one rule-injected request to ${o.upstream.origin}${o.upstream.pathname}`]
              : []),
          ],
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // ---- live ----
  let key: string | undefined;
  if (o.keyFile) key = readFileSync(o.keyFile, "utf8").trim();
  else key = readEnvFileVar(readFileSync(join(homedir(), ".secrets"), "utf8"), "DAYTONA_API_KEY");
  if (!key) {
    console.error("no Daytona key: pass --key-file, or put DAYTONA_API_KEY in ~/.secrets");
    process.exit(1);
  }
  const { probeEgress } = await import("../../core/src/run/egress-canary");
  const usage: UsageRecord[] = [];
  const provider = new DaytonaProvider({
    apiKey: () => key!,
    maxLive: 2,
    runId: `proxy-live-${Date.now().toString(36)}`,
    allowDomainListConfinement: o.confine === "domain",
    capacityWaitMs: 10 * 60_000,
    onUsage: (r) => usage.push(r),
  });
  await provider.healthcheck();
  const existing = await provider.count({});
  if (existing > 0) {
    console.error(
      `refusing to start: ${existing} sandbox(es) labelled ${OWN_LABEL}=${OWN_LABEL_VALUE} already exist (not ours to delete blindly)`,
    );
    process.exit(1);
  }

  const results: { check: string; ok: boolean; detail: string }[] = [];
  const record = (check: string, ok: boolean, detail: string): void => {
    results.push({ check, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${check}: ${detail}`);
  };
  const dec = new TextDecoder();
  const sh = async (id: string, script: string, seconds = 60): Promise<string> => {
    const { execId } = await provider.exec.start(id, {
      argv: ["sh", "-c", script],
      timeoutSeconds: seconds,
    });
    for (;;) {
      const st = await provider.exec.status(id, execId);
      if (st.state !== "running") break;
      await Bun.sleep(300);
    }
    const logs = await provider.exec.logs(id, execId, { fromOffset: 0, maxBytes: 16 * 1024 });
    return dec.decode(logs.bytes).trim();
  };

  let sandboxId: string | undefined;
  try {
    const handle = await provider.create(spec);
    sandboxId = handle.id;
    console.log(
      `created ${handle.id}; proxy as the sandbox sees it: ${handle.proxy?.host}:${handle.proxy?.port}`,
    );

    const direct = await probeEgress(provider, handle.id);
    record(
      "direct egress is closed",
      direct.kind === "blocked",
      direct.kind === "blocked"
        ? "the canary's public and metadata targets did not answer"
        : JSON.stringify(direct),
    );
    const targets = handle.mustNotReach ?? [];
    const closed = await probeEgress(provider, handle.id, { targets });
    record(
      "everything the provider says must not be reachable is closed",
      targets.length > 0 && closed.kind === "blocked",
      targets.length === 0
        ? "the provider named no targets"
        : closed.kind === "blocked"
          ? `${targets.length} targets closed`
          : JSON.stringify(closed),
    );

    const connect = await sh(handle.id, BAD_CREDENTIAL_CHECK, 30);
    record(
      "the proxy is open through the relay and refuses a bad credential",
      connect.trim() === "407",
      `CONNECT answered ${connect.trim() || "nothing"}`,
    );

    if (o.credentialFile && o.upstream) {
      const cred = JSON.parse(readFileSync(o.credentialFile, "utf8")) as {
        username?: string;
        password?: string;
        caPem?: string;
      };
      if (!cred.username || !cred.password || !cred.caPem)
        throw new Error("the credential file needs username, password and caPem");
      await sh(handle.id, "mkdir -p /tmp/longshore-proxy && chmod 700 /tmp/longshore-proxy", 15);
      await provider.files.put(
        handle.id,
        "/tmp/longshore-proxy/auth",
        new TextEncoder().encode(`${cred.username}:${cred.password}`),
      );
      await provider.files.put(
        handle.id,
        "/tmp/longshore-proxy/ca.pem",
        new TextEncoder().encode(cred.caPem),
      );
      const out = await sh(handle.id, INJECTED_CHECK(o.upstream.toString(), o.expect), 60);
      const status = /status=(\d+)/.exec(out)?.[1];
      const marker = /marker=(present|absent)/.exec(out)?.[1];
      record(
        "a rule-injected request reaches the test upstream",
        status === "200" && (o.expect === undefined || marker === "present"),
        `status ${status ?? "none"}${o.expect ? `, marker ${marker ?? "unknown"}` : ""}`,
      );
    }
  } catch (e) {
    record(
      "the check ran to the end",
      false,
      e instanceof Error ? e.message.slice(0, 200) : "error",
    );
  } finally {
    if (sandboxId)
      await provider.destroy(sandboxId).catch((e) => console.error(`destroy failed: ${String(e)}`));
    const left = await provider.count({});
    const swept = left > 0 ? await provider.destroyByLabels({ [OWN_LABEL]: OWN_LABEL_VALUE }) : 0;
    const seconds = usage.reduce((n, r) => n + r.seconds, 0);
    console.log(
      `sandboxes: ${usage.length}; sandbox-seconds ${seconds} = ${(seconds / 60).toFixed(1)} min; swept ${swept}; remaining ${await provider.count({})}`,
    );
  }
  const remaining = await provider.count({});
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 || remaining !== 0 ? 1 : 0);
}
