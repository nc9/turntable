import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  createWrappedExec,
  type Labels,
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
  MANAGED_LABEL,
  PUT_SH,
  buildExecArgs,
  buildPsArgs,
  buildRunArgs,
} from "./commands";

export interface DockerProviderOptions {
  /** Docker CLI binary. Default `docker`. */
  docker?: string;
  /** Per-file byte cap. Default 64 MiB. */
  maxFileBytes?: number;
  exec?: WrappedExecOptions;
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

  constructor(opts: DockerProviderOptions = {}) {
    this.bin = opts.docker ?? "docker";
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.info = {
      name: "docker",
      createFrom: ["image"],
      exec: { detached: true, logsByOffset: true, streaming: false, tty: false },
      files: { upload: true, download: true, maxBytes: this.maxFileBytes },
      network: { egressPolicy: ["none"], ingress: false, proxyReachability: true },
      resources: { cpus: true, memoryMb: true, diskGb: false },
      ttl: true,
      labels: true,
      list: true,
      listByLabel: true,
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

  async create(spec: SandboxSpec) {
    const now = Date.now();
    const res = await this.cli(buildRunArgs(spec, now), undefined, 600_000);
    if (res.exitCode !== 0) this.fail("docker run", res);
    const id = dec.decode(res.stdout).trim().split("\n").pop() ?? "";
    if (!/^[0-9a-f]{64}$/.test(id)) throw new InfraError(`docker run: unexpected output`);
    return { id, startedAt: now };
  }

  async destroy(id: string): Promise<void> {
    const res = await this.cli(["rm", "-f", id]);
    if (res.exitCode === 0) return;
    const err = dec.decode(res.stderr);
    if (/No such container|is already in progress/i.test(err)) return;
    this.fail("docker rm", res);
  }

  async destroyByLabels(labels: Labels): Promise<number> {
    if (Object.keys(labels).length === 0) throw new SpecError("destroyByLabels needs labels");
    const found = await this.list({ labels });
    for (const s of found) await this.destroy(s.id);
    return found.length;
  }

  async list(filter: { labels?: Labels }): Promise<SandboxInfo[]> {
    const ps = await this.cli(buildPsArgs(filter.labels));
    if (ps.exitCode !== 0) this.fail("docker ps", ps);
    const ids = dec.decode(ps.stdout).split("\n").filter(Boolean);
    if (ids.length === 0) return [];
    const insp = await this.cli(["inspect", "--format", "{{json .}}", ...ids]);
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
        Object.entries(c.Config.Labels ?? {}).filter(
          ([k]) => k !== MANAGED_LABEL && k !== EXPIRES_LABEL,
        ),
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
