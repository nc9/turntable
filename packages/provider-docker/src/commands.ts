import { SpecError, type Labels, type SandboxSpec } from "@longshore/provider-sdk";

/** Label on every container this provider creates. Listing and destroying only touch these. */
export const MANAGED_LABEL = "longshore.managed";
export const EXPIRES_LABEL = "longshore.expires-at";

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
  if (spec.network.egress !== "none" && spec.network.egress !== "open") {
    throw new SpecError(`docker provider cannot enforce egress policy ${spec.network.egress}`);
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
    }),
  );
  if (spec.network.egress === "none") args.push("--network", "none");
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
