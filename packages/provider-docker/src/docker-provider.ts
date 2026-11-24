import {
  DOCKER_ENV_PASSTHROUGH,
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  createWrappedExec,
  scrubbedEnv,
  type ClassRealisation,
  type Labels,
  type ProviderClassSettings,
  type SandboxResources,
  type Provider,
  type ProviderInfo,
  type SandboxInfo,
  type SandboxSpec,
  type ShellRunner,
  type WrappedExecOptions,
} from "@turntable/provider-sdk";
import {
  EXPIRES_LABEL,
  GET_SH,
  INTERNAL_LABELS,
  LEGACY_EXPIRES_LABEL,
  LEGACY_NET_LABEL,
  LEGACY_RELAY_LABEL,
  MANAGED_LABELS,
  NET_LABEL,
  PUT_SH,
  RELAY_LABEL,
  RELAY_PORT,
  netName,
  relayName,
  DEFAULT_HARDENING,
  assertRef,
  firstAddress,
  buildExecArgs,
  buildInspectArgs,
  buildPsArgs,
  labelTemplate,
  buildNetworkCreateArgs,
  buildRelayRunArgs,
  buildRmArgs,
  buildRunArgs,
  type Hardening,
} from "./commands";

export interface DockerProviderOptions {
  /** Docker CLI binary. Default `docker`. */
  docker?: string;
  /** Per-file byte cap. Default 64 MiB. */
  maxFileBytes?: number;
  exec?: WrappedExecOptions;
  /** Container hardening overrides. Defaults: no-new-privileges, pids-limit 4096, drop NET_RAW. */
  hardening?: Partial<Hardening>;
  /**
   * Declare that the sandboxes can run a Docker daemon (the operator's runtime and image allow
   * it). Default false: a plain hardened container cannot.
   */
  dockerInSandbox?: boolean;
}

interface Result {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

const dec = new TextDecoder();

/** Docker CLI errors that mean the request itself is wrong, so retrying cannot help. */
const SPEC_PATTERNS = [
  /pull access denied/i,
  /manifest unknown/i,
  /invalid reference format/i,
  /repository does not exist/i,
  /is already in use by container/i,
  /No such image/i,
];

export class DockerProvider implements Provider {
  readonly info: ProviderInfo;
  readonly exec: Provider["exec"];
  readonly files: Provider["files"];
  private readonly bin: string;
  private readonly maxFileBytes: number;
  private readonly hardening: Hardening;

  constructor(opts: DockerProviderOptions = {}) {
    this.bin = opts.docker ?? "docker";
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.hardening = { ...DEFAULT_HARDENING, ...opts.hardening };
    this.info = {
      name: "docker",
      // runsc is gVisor; any other runtime (or none) shares the host kernel.
      isolation: this.hardening.runtime === "runsc" ? "gvisor" : "container",
      createFrom: ["image"],
      exec: { detached: true, logsByOffset: true, streaming: false, tty: false },
      files: { upload: true, download: true, maxBytes: this.maxFileBytes },
      network: {
        egressPolicy: ["none", "open", "deny-all-except-proxy"],
        ingress: false,
        proxyReachability: true,
      },
      resources: { cpus: true, memoryMb: true, diskGb: false },
      ttl: true,
      labels: true,
      list: true,
      listByLabel: true,
      // Docker inside a container needs a privileged or sysbox-style runtime: opt in explicitly.
      ...(opts.dockerInSandbox === true ? { dockerInSandbox: true } : {}),
      os: ["linux"],
      arch: ["amd64", "arm64"],
      cost: "none",
    };
    const runner: ShellRunner = {
      run: async (id, argv, { timeoutMs }) => {
        const res = await this.cli(buildExecArgs(id, argv, false), undefined, timeoutMs);
        return this.mapExecResult(res);
      },
    };
    this.exec = createWrappedExec(runner, opts.exec);
    this.files = {
      put: async (id, path, bytes) => {
        if (bytes.length > this.maxFileBytes) {
          throw new FileTooLargeError(`${bytes.length} bytes exceeds ${this.maxFileBytes}`);
        }
        const res = await this.cli(
          buildExecArgs(id, ["sh", "-c", PUT_SH, "tt", path], true),
          bytes,
          120_000,
        );
        const r = this.mapExecResult(res);
        if (r.exitCode !== 0) throw new SpecError(`put failed: ${dec.decode(r.stderr).trim()}`);
      },
      get: async (id, path, maxBytes) => {
        const res = await this.cli(
          buildExecArgs(id, ["sh", "-c", GET_SH, "tt", path, String(maxBytes + 1)], false),
          undefined,
          120_000,
        );
        const r = this.mapExecResult(res);
        if (r.exitCode !== 0) throw new SpecError(`get failed: ${dec.decode(r.stderr).trim()}`);
        if (r.stdout.length > maxBytes) {
          throw new FileTooLargeError(`file exceeds ${maxBytes} bytes`);
        }
        return r.stdout;
      },
    };
  }

  /** Runs the docker CLI. Spawn or daemon trouble is an InfraError. */
  private async cli(args: string[], stdin?: Uint8Array, timeoutMs = 60_000): Promise<Result> {
    let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.bin, ...args], {
        stdin: stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        env: scrubbedEnv({}, DOCKER_ENV_PASSTHROUGH),
      }) as typeof proc;
    } catch (e) {
      throw new InfraError(`cannot run ${this.bin}`, e);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).bytes(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** For exec results: a missing container is SandboxNotFoundError; daemon trouble is Infra. */
  private mapExecResult(res: Result): Result {
    if (res.exitCode === 0) return res;
    const err = dec.decode(res.stderr);
    if (/No such container/i.test(err)) throw new SandboxNotFoundError(err.trim());
    if (/is not running/i.test(err)) throw new SandboxNotFoundError(err.trim());
    if (/Cannot connect to the Docker daemon/i.test(err)) throw new InfraError(err.trim());
    return res;
  }

  private fail(what: string, res: Result): never {
    const err = dec.decode(res.stderr).trim();
    if (SPEC_PATTERNS.some((re) => re.test(err))) throw new SpecError(`${what}: ${err}`);
    throw new InfraError(`${what}: ${err}`);
  }

  async healthcheck(): Promise<void> {
    const res = await this.cli(["version", "--format", "{{.Server.Version}}"], undefined, 15_000);
    if (res.exitCode !== 0) this.fail("docker daemon unreachable", res);
  }

  /** A class is cpus, memory and `image`. Docker cannot limit disk, so a class that asks refuses. */
  realiseClass(cls: SandboxResources, specific?: ProviderClassSettings): ClassRealisation {
    const extra = Object.keys(specific ?? {}).filter((k) => k !== "image");
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `docker cannot realise the class setting ${extra[0]!.slice(0, 40)}`,
      };
    }
    if (cls.diskGb !== undefined) {
      return { ok: false, reason: "docker cannot limit disk, and the class asks for a disk size" };
    }
    const image = specific?.image;
    if (
      image !== undefined &&
      (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image))
    ) {
      return {
        ok: false,
        reason: "docker cannot use the class image: not a valid image reference",
      };
    }
    return { ok: true, resources: { ...cls }, ...(image !== undefined ? { image } : {}) };
  }

  async create(spec: SandboxSpec) {
    const now = Date.now();
    if (spec.network.egress === "deny-all-except-proxy") return this.createProxied(spec, now);
    const res = await this.cli(buildRunArgs(spec, now, this.hardening), undefined, 600_000);
    if (res.exitCode !== 0) this.fail("docker run", res);
    const id = dec.decode(res.stdout).trim().split("\n").pop() ?? "";
    if (!/^[0-9a-f]{64}$/.test(id)) throw new InfraError(`docker run: unexpected output`);
    return { id, startedAt: now };
  }

  /**
   * A sandbox on an internal network (no route out) whose only neighbour is a relay container
   * that forwards one port to the controller's proxy. Anything that fails removes what was made.
   */
  private async createProxied(spec: SandboxSpec, now: number) {
    const net = netName(spec.name);
    const relay = relayName(spec.name);
    const cleanup = async (): Promise<void> => {
      await this.cli(buildRmArgs(relay)).catch(() => undefined);
      await this.cli(["network", "rm", net]).catch(() => undefined);
    };
    await this.reapExpired().catch(() => undefined);
    // Fail closed: without isolated gateways the host is reachable from the sandbox.
    const ver = await this.cli(["version", "--format", "{{.Server.Version}}"], undefined, 15_000);
    const major = Number(dec.decode(ver.stdout).trim().split(".")[0]);
    if (ver.exitCode !== 0 || !Number.isInteger(major) || major < 28) {
      throw new SpecError(
        "deny-all-except-proxy needs Docker 28 or newer (isolated bridge gateways); not started",
      );
    }
    const made = await this.cli(buildNetworkCreateArgs(net, now, spec.ttlSeconds));
    if (made.exitCode !== 0) this.fail("docker network create", made);
    try {
      const r = await this.cli(buildRelayRunArgs(spec, now), undefined, 600_000);
      if (r.exitCode !== 0) this.fail("docker run (relay)", r);
      const joined = await this.cli(["network", "connect", net, relay]);
      if (joined.exitCode !== 0) this.fail("docker network connect", joined);
      const insp = await this.cli([
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`,
        "--",
        relay,
      ]);
      const ip = dec.decode(insp.stdout).trim();
      if (insp.exitCode !== 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        throw new InfraError("cannot find the relay's address");
      }
      // The host's would-be address on this network (the first one): the sandbox must not reach
      // the proxy's listener, or anything else, through it.
      const sub = await this.cli([
        "network",
        "inspect",
        "--format",
        "{{(index .IPAM.Config 0).Subnet}}",
        net,
      ]);
      const gateway = firstAddress(dec.decode(sub.stdout).trim());
      // Without the address there is nothing to verify closed: do not start.
      if (sub.exitCode !== 0 || !gateway) {
        throw new InfraError("cannot determine the host's address on the sandbox network");
      }
      // Ready when it says so; a sandbox that dials first would see a refused connection.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const logs = await this.cli(["logs", "--", relay]);
        if (dec.decode(logs.stdout).includes("ready")) break;
        if (Date.now() > deadline) throw new InfraError("the proxy relay did not start");
        await Bun.sleep(150);
      }
      const res = await this.cli(buildRunArgs(spec, now, this.hardening), undefined, 600_000);
      if (res.exitCode !== 0) this.fail("docker run", res);
      const id = dec.decode(res.stdout).trim().split("\n").pop() ?? "";
      if (!/^[0-9a-f]{64}$/.test(id)) throw new InfraError(`docker run: unexpected output`);
      return {
        id,
        startedAt: now,
        proxy: { host: ip, port: RELAY_PORT },
        mustNotReach: [`${gateway}:${spec.network.proxy?.port ?? RELAY_PORT}`, `${gateway}:80`],
      };
    } catch (e) {
      await cleanup();
      throw e;
    }
  }

  /** Removes internal networks (and their relays) whose sandbox TTL passed and that nothing uses. */
  private async reapExpired(): Promise<void> {
    const ids = new Set<string>();
    for (const managed of MANAGED_LABELS) {
      const ls = await this.cli(["network", "ls", "-q", "--filter", `label=${managed}=1`]);
      for (const id of dec.decode(ls.stdout).split("\n").filter(Boolean)) ids.add(id);
    }
    for (const id of ids) {
      const insp = await this.cli([
        "network",
        "inspect",
        "--format",
        `${labelTemplate(".Labels", EXPIRES_LABEL, LEGACY_EXPIRES_LABEL)} {{.Name}}`,
        id,
      ]);
      const [exp, name] = dec.decode(insp.stdout).trim().split(" ");
      if (!name || !/^\d+$/.test(exp ?? "") || Number(exp) > Date.now()) continue;
      await this.cli(buildRmArgs(name.replace(/-net$/, "-relay"))).catch(() => undefined);
      await this.cli(["network", "rm", name]).catch(() => undefined);
    }
  }

  async destroy(id: string): Promise<void> {
    // A proxied sandbox has a relay and a network to remove with it; read them before it goes.
    const links = await this.cli([
      "inspect",
      "--format",
      `${labelTemplate(".Config.Labels", RELAY_LABEL, LEGACY_RELAY_LABEL)} ${labelTemplate(".Config.Labels", NET_LABEL, LEGACY_NET_LABEL)}`,
      "--",
      assertRef(id),
    ]);
    const [relay, net] =
      links.exitCode === 0 ? dec.decode(links.stdout).trim().split(" ") : [undefined, undefined];
    const res = await this.cli(buildRmArgs(id));
    const err = dec.decode(res.stderr);
    if (res.exitCode !== 0 && !/No such container|is already in progress/i.test(err)) {
      this.fail("docker rm", res);
    }
    if (relay) await this.cli(buildRmArgs(relay));
    // A network that cannot be removed now is swept by its expiry at the next create.
    if (net) await this.cli(["network", "rm", net]);
  }

  async destroyByLabels(labels: Labels): Promise<number> {
    if (Object.keys(labels).length === 0) throw new SpecError("destroyByLabels needs labels");
    const found = await this.list({ labels });
    for (const s of found) await this.destroy(s.id);
    return found.length;
  }

  async list(filter: { labels?: Labels }): Promise<SandboxInfo[]> {
    // Containers started before the rename carry the old managed label: ask for both, merge.
    const found = new Set<string>();
    for (const managed of MANAGED_LABELS) {
      const ps = await this.cli(buildPsArgs(filter.labels, managed));
      if (ps.exitCode !== 0) this.fail("docker ps", ps);
      for (const id of dec.decode(ps.stdout).split("\n").filter(Boolean)) found.add(id);
    }
    const ids = [...found];
    if (ids.length === 0) return [];
    const insp = await this.cli(buildInspectArgs(ids));
    // A container can vanish between ps and inspect (it is --rm); inspect then exits 1 but
    // still prints the rest.
    const out: SandboxInfo[] = [];
    for (const line of dec.decode(insp.stdout).split("\n").filter(Boolean)) {
      const c = JSON.parse(line) as {
        Id: string;
        Name: string;
        Created: string;
        Config: { Labels: Record<string, string> };
      };
      const labels = Object.fromEntries(
        Object.entries(c.Config.Labels ?? {}).filter(([k]) => !INTERNAL_LABELS.has(k)),
      );
      out.push({
        id: c.Id,
        name: c.Name.replace(/^\//, ""),
        labels,
        createdAt: Date.parse(c.Created),
      });
    }
    return out;
  }

  async count(filter: { labels?: Labels }): Promise<number> {
    return (await this.list(filter)).length;
  }
}

/**
 * The address of the Docker bridge on this Linux host (`docker0`'s gateway), which is where
 * `host.docker.internal:host-gateway` points: binding the secrets proxy there reaches containers
 * and no other interface. Undefined when it cannot be determined, or off Linux (Docker Desktop
 * routes `host.docker.internal` to the host's loopback instead).
 */
export async function dockerBridgeGateway(
  bin = "docker",
  platform: string = process.platform,
): Promise<string | undefined> {
  if (platform !== "linux") return undefined;
  try {
    const p = Bun.spawn(
      [bin, "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 10_000,
        env: scrubbedEnv({}, DOCKER_ENV_PASSTHROUGH),
      },
    );
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}
