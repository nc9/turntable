import { SpecError, type Labels, type SandboxSpec } from "@turntable/provider-sdk";

/** Label on every container this provider creates. Listing and destroying only touch these. */
export const MANAGED_LABEL = "turntable.managed";
export const EXPIRES_LABEL = "turntable.expires-at";

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

/**
 * `docker run` argv for a sandbox. No `-e`/`--env`/`--env-file`: env never passes through a
 * provider. The TTL backstop is the container's own main process: `sleep <ttl>` ends, and
 * `--rm` removes the container, even if the controller is gone.
 */
export function buildRunArgs(spec: SandboxSpec, nowMs: number): string[] {
  if (spec.image === undefined) throw new SpecError("docker provider needs spec.image");
  if (spec.snapshot !== undefined || spec.template !== undefined) {
    throw new SpecError("docker provider supports image only");
  }
  if (spec.network.egress !== "none") {
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
  if (r.cpus !== undefined) {
    if (!(r.cpus > 0)) throw new SpecError("cpus must be positive");
    args.push("--cpus", String(r.cpus));
  }
  if (r.memoryMb !== undefined) {
    if (!Number.isInteger(r.memoryMb) || r.memoryMb < 6) throw new SpecError("bad memoryMb");
    args.push("--memory", `${r.memoryMb}m`);
  }
  args.push(spec.image, "sleep", String(spec.ttlSeconds));
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
  return ["exec", ...(stdin ? ["-i"] : []), id, ...argv];
}

/** Script for files.put. Args: path. Reads the body from stdin. */
export const PUT_SH = 'mkdir -p "$(dirname "$1")" && cat > "$1"';
/** Script for files.get. Args: path limit. Reads at most limit bytes. */
export const GET_SH = 'head -c "$2" "$1"';
