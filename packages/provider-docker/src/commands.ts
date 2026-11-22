import { SpecError, type Labels, type SandboxSpec } from "@longshore/provider-sdk";

/** Label on every container this provider creates. Listing and destroying only touch these. */
export const MANAGED_LABEL = "longshore.managed";
export const EXPIRES_LABEL = "longshore.expires-at";
/** Labels that link a proxied sandbox to its relay container and internal network. */
export const NET_LABEL = "longshore.net";
export const RELAY_LABEL = "longshore.relay";
/** Port the relay listens on, inside the sandbox's internal network. */
export const RELAY_PORT = 3128;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function sanitizeName(name: string): string {
  const s = name.replaceAll(/[^a-zA-Z0-9_.-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
  const out = s.slice(0, 128);
  if (!NAME_RE.test(out)) throw new SpecError(`invalid sandbox name: ${JSON.stringify(name)}`);
  return out;
}

export function labelArgs(labels: Labels): string[] {
  return Object.entries(labels).flatMap(([k, v]) => {
    if (k.length === 0 || k.includes("=")) throw new SpecError(`invalid label key: ${k}`);
    return ["--label", `${k}=${v}`];
  });
}

/** Image reference: no leading dash, no whitespace or shell-ish characters. */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
/** Container id or name. */
const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RUNTIME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const CAP_RE = /^[A-Z_]{2,32}$/;

export function assertImage(image: string): string {
  if (!IMAGE_RE.test(image))
    throw new SpecError(`invalid image reference: ${JSON.stringify(image)}`);
  return image;
}

/** Validates a container id or name before it reaches any docker CLI call. */
export function assertRef(ref: string): string {
  if (!REF_RE.test(ref)) throw new SpecError(`invalid container reference: ${JSON.stringify(ref)}`);
  return ref;
}

export interface Hardening {
  /** `--security-opt no-new-privileges`. Default true. */
  noNewPrivileges: boolean;
  /** `--pids-limit`. Default 4096. 0 disables. */
  pidsLimit: number;
  /** `--cap-drop`. Default `["NET_RAW"]`. */
  capDrop: readonly string[];
  /** `--runtime`, for example `runsc` (gVisor). Default unset. */
  runtime?: string;
}

export const DEFAULT_HARDENING: Hardening = {
  noNewPrivileges: true,
  pidsLimit: 4096,
  capDrop: ["NET_RAW"],
};

/**
 * `docker run` argv for a sandbox. No `-e`/`--env`/`--env-file`: env never passes through a
 * provider. The TTL backstop is the container's own main process: `sleep <ttl>` ends, and
 * `--rm` removes the container, even if the controller is gone. Egress `none` becomes
 * `--network none`; `open` keeps the default bridge. `--` stops option parsing before the image.
 */
export function buildRunArgs(
  spec: SandboxSpec,
  nowMs: number,
  hardening: Hardening = DEFAULT_HARDENING,
): string[] {
  if (spec.image === undefined) throw new SpecError("docker provider needs spec.image");
  const image = assertImage(spec.image);
  if (spec.snapshot !== undefined || spec.template !== undefined) {
    throw new SpecError("docker provider supports image only");
  }
  const proxied = spec.network.egress === "deny-all-except-proxy";
  if (spec.network.egress !== "none" && spec.network.egress !== "open" && !proxied) {
    throw new SpecError(`docker provider cannot enforce egress policy ${spec.network.egress}`);
  }
  if (proxied && spec.network.proxy === undefined) {
    throw new SpecError("deny-all-except-proxy needs network.proxy");
  }
  if (!Number.isInteger(spec.ttlSeconds) || spec.ttlSeconds <= 0) {
    throw new SpecError("ttlSeconds must be a positive integer");
  }
  const r = spec.resources ?? {};
  if (r.diskGb !== undefined) throw new SpecError("docker provider cannot limit disk");
  const args = ["run", "-d", "--rm", "--init", "--name", sanitizeName(spec.name)];
  args.push(
    ...labelArgs({
      ...spec.labels,
      [MANAGED_LABEL]: "1",
      [EXPIRES_LABEL]: String(nowMs + spec.ttlSeconds * 1000),
      ...(proxied ? { [NET_LABEL]: netName(spec.name), [RELAY_LABEL]: relayName(spec.name) } : {}),
    }),
  );
  if (spec.network.egress === "none") args.push("--network", "none");
  // An internal network has no route out; its only other member is the relay.
  if (proxied) args.push("--network", netName(spec.name));
  // With a network, the sandbox can reach the host's control plane (the cache service) by name.
  else if (spec.network.egress !== "none")
    args.push("--add-host", "host.docker.internal:host-gateway");
  if (hardening.noNewPrivileges) args.push("--security-opt", "no-new-privileges");
  if (hardening.pidsLimit > 0) args.push("--pids-limit", String(hardening.pidsLimit));
  for (const cap of hardening.capDrop) {
    if (!CAP_RE.test(cap)) throw new SpecError(`invalid capability: ${cap}`);
    args.push("--cap-drop", cap);
  }
  if (hardening.runtime !== undefined) {
    if (!RUNTIME_RE.test(hardening.runtime)) throw new SpecError("invalid runtime name");
    args.push("--runtime", hardening.runtime);
  }
  if (r.cpus !== undefined) {
    if (!(r.cpus > 0)) throw new SpecError("cpus must be positive");
    args.push("--cpus", String(r.cpus));
  }
  if (r.memoryMb !== undefined) {
    if (!Number.isInteger(r.memoryMb) || r.memoryMb < 6) throw new SpecError("bad memoryMb");
    args.push("--memory", `${r.memoryMb}m`);
  }
  args.push("--", image, "sleep", String(spec.ttlSeconds));
  return args;
}

/** `docker ps` argv that lists managed containers matching all labels, ids only. */
export function buildPsArgs(labels: Labels | undefined): string[] {
  const filters = Object.entries({ ...labels, [MANAGED_LABEL]: "1" }).flatMap(([k, v]) => [
    "--filter",
    `label=${k}=${v}`,
  ]);
  return ["ps", "-aq", "--no-trunc", ...filters];
}

/** `docker exec` argv for a short command. `-i` only when stdin is supplied. */
export function buildExecArgs(id: string, argv: readonly string[], stdin: boolean): string[] {
  return ["exec", ...(stdin ? ["-i"] : []), "--", assertRef(id), ...argv];
}

export function buildRmArgs(id: string): string[] {
  return ["rm", "-f", "--", assertRef(id)];
}

export function buildInspectArgs(ids: readonly string[]): string[] {
  return ["inspect", "--format", "{{json .}}", "--", ...ids.map(assertRef)];
}

/** Script for files.put. Args: path. Reads the body from stdin. */
export const PUT_SH = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
/** Script for files.get. Args: path limit. Reads at most limit bytes. */
export const GET_SH = 'head -c "$2" "$1"';

export const netName = (sandboxName: string): string => `${sanitizeName(sandboxName)}-net`;
export const relayName = (sandboxName: string): string => `${sanitizeName(sandboxName)}-relay`;

/** An internal network (no route out) for one sandbox. Labelled so a sweep can find it. */
export function buildNetworkCreateArgs(name: string, nowMs: number, ttlSeconds: number): string[] {
  return [
    "network",
    "create",
    "--internal",
    // No address for the host on this network (Docker 28+): the sandbox cannot reach the host's
    // own listeners through the gateway. Without this a service on 0.0.0.0 would be reachable.
    "-o",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    ...labelArgs({ [MANAGED_LABEL]: "1", [EXPIRES_LABEL]: String(nowMs + ttlSeconds * 1000) }),
    "--",
    assertRef(name),
  ];
}

/**
 * The relay's program. It forwards one local port to the controller's proxy, and exits at the
 * sandbox's TTL. node: the relay runs in the sandbox image, so no extra image is pulled. This text
 * runs inside the relay container, not in the control plane.
 */
export const RELAY_JS = `
const { createServer, connect } = require("net");
const [lp, host, port, ttl] = process.argv.slice(1);
createServer((c) => {
  const u = connect(Number(port), host);
  const k = () => { c.destroy(); u.destroy(); };
  c.on("error", k); u.on("error", k); c.on("close", k); u.on("close", k);
  c.pipe(u); u.pipe(c);
}).listen(Number(lp), "0.0.0.0", () => console.log("ready"));
setTimeout(() => process.exit(0), Number(ttl) * 1000);
`;

/** The relay container: on the default bridge (it reaches the host), joined to the internal network afterwards. */
export function buildRelayRunArgs(spec: SandboxSpec, nowMs: number): string[] {
  if (spec.image === undefined || spec.network.proxy === undefined) {
    throw new SpecError("relay needs an image and a proxy address");
  }
  const { host, port } = spec.network.proxy;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SpecError("invalid proxy address");
  }
  return [
    "run",
    "-d",
    "--rm",
    "--init",
    "--name",
    relayName(spec.name),
    ...labelArgs({
      [RELAY_LABEL]: sanitizeName(spec.name),
      [EXPIRES_LABEL]: String(nowMs + spec.ttlSeconds * 1000),
    }),
    "--add-host",
    "host.docker.internal:host-gateway",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--read-only",
    "--",
    assertImage(spec.image),
    "node",
    "-e",
    RELAY_JS,
    String(RELAY_PORT),
    host,
    String(port),
    String(spec.ttlSeconds),
  ];
}

/** The first host address of an IPv4 subnet (`172.20.0.0/16` gives `172.20.0.1`), or undefined. */
export function firstAddress(subnet: string): string | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet);
  if (!m) return undefined;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255) || Number(m[5]) > 30) return undefined;
  parts[3] = (parts[3] ?? 0) + 1;
  return parts.join(".");
}
