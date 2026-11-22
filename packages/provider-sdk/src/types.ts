/**
 * Provider contract. Rule zero: no method may need a long-lived stream for correctness.
 * Detached start, status polling and offset-based log reads are authoritative; streaming is an
 * optional optimisation layered on top.
 */

export type Labels = Readonly<Record<string, string>>;

/** `none` means unrestricted egress. */
export type EgressPolicy = "none" | "allowlist" | "deny-all-except-proxy";

export interface ProviderInfo {
  /** Stable provider id, for example `docker`. */
  name: string;
  createFrom: readonly ("image" | "snapshot" | "template")[];
  exec: {
    /** Always true: start returns at once and the command outlives the control connection. */
    detached: true;
    logsByOffset: true;
    /** Provider can additionally push logs over a stream (optimisation only). */
    streaming: boolean;
    tty: boolean;
  };
  files: { upload: boolean; download: boolean; maxBytes?: number };
  network: {
    /** Egress policies the provider can enforce. */
    egressPolicy: readonly EgressPolicy[];
    ingress: boolean;
    /** A sandbox can reach a controller-side proxy endpoint. */
    proxyReachability: boolean;
  };
  resources: { cpus: boolean; memoryMb: boolean; diskGb: boolean };
  ttl: boolean;
  labels: boolean;
  list: boolean;
  listByLabel: boolean;
  os: readonly string[];
  arch: readonly string[];
  cost: "none" | "estimate" | "exact";
}

export interface SandboxResources {
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
}

export interface SandboxNetworkSpec {
  egress: EgressPolicy;
  /** Hostnames for the `allowlist` policy. */
  allowHosts?: readonly string[];
}

/**
 * Deliberately has NO env field. Environment never passes through a provider: secrets reach a
 * sandbox only through the secrets proxy, never as process env set by the controller.
 */
export interface SandboxSpec {
  name: string;
  labels: Labels;
  image?: string;
  snapshot?: string;
  template?: string;
  resources?: SandboxResources;
  /** Hard lifetime backstop. The provider reaps the sandbox after this many seconds. */
  ttlSeconds: number;
  network: SandboxNetworkSpec;
}

export interface SandboxHandle {
  id: string;
  startedAt: number;
}

export interface SandboxInfo {
  id: string;
  name: string;
  labels: Labels;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface ExecStartOptions {
  argv: readonly string[];
  cwd?: string;
  /** Wall-clock limit enforced inside the sandbox. Must be a positive integer. */
  timeoutSeconds: number;
}

/**
 * `running`: alive. `exited`: finished on its own, exitCode is authoritative.
 * `killed`: stopped by kill, timeout or the output ceiling (exitCode is 128+signal).
 * `lost`: no result and no live process (sandbox rebooted or wiped, wrapper died).
 */
export type ExecState = "running" | "exited" | "killed" | "lost";

export interface ExecStatus {
  state: ExecState;
  exitCode?: number;
  /** Epoch milliseconds. */
  endedAt?: number;
  /** Epoch milliseconds of the last wrapper heartbeat, when known. */
  lastHeartbeatAt?: number;
}

export interface ExecLogsOptions {
  fromOffset: number;
  maxBytes: number;
}

export interface ExecLogs {
  bytes: Uint8Array;
  /** Pass as `fromOffset` next time. Offsets are logical positions in the full output. */
  nextOffset: number;
  /** The command has finished and nextOffset is the end of its output. */
  eof: boolean;
}

export type KillSignal = "TERM" | "KILL" | "INT" | "HUP" | "QUIT" | "USR1" | "USR2";

export interface ProviderExec {
  /** Returns as soon as the command is launched. No state is held in the provider instance. */
  start(sandboxId: string, opts: ExecStartOptions): Promise<{ execId: string }>;
  status(sandboxId: string, execId: string): Promise<ExecStatus>;
  logs(sandboxId: string, execId: string, opts: ExecLogsOptions): Promise<ExecLogs>;
  /** Idempotent. Signalling a finished command succeeds. */
  kill(sandboxId: string, execId: string, signal: KillSignal): Promise<void>;
}

export interface ProviderFiles {
  /** Throws FileTooLargeError when bytes exceed the cap. */
  put(sandboxId: string, path: string, bytes: Uint8Array): Promise<void>;
  /** Throws FileTooLargeError when the file exceeds maxBytes. */
  get(sandboxId: string, path: string, maxBytes: number): Promise<Uint8Array>;
}

export interface Provider {
  readonly info: ProviderInfo;
  healthcheck(): Promise<void>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Idempotent: a missing sandbox is success. */
  destroy(sandboxId: string): Promise<void>;
  /** Destroys every sandbox whose labels include all of `labels`. Returns how many. */
  destroyByLabels(labels: Labels): Promise<number>;
  list(filter: { labels?: Labels }): Promise<SandboxInfo[]>;
  count(filter: { labels?: Labels }): Promise<number>;
  exec: ProviderExec;
  files: ProviderFiles;
}
