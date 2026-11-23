/**
 * Provider contract. Rule zero: no method may need a long-lived stream for correctness.
 * Detached start, status polling and offset-based log reads are authoritative; streaming is an
 * optional optimisation layered on top.
 */

export type Labels = Readonly<Record<string, string>>;

/**
 * `none`: no network egress at all. `open`: unrestricted egress. `allowlist`: only listed hosts.
 * `deny-all-except-proxy`: only the controller-side proxy is reachable, enforced at the network
 * level (by address, or by the provider's own isolation).
 * `proxy-domain-filtered`: only the proxy's name is reachable, enforced by a filter that reads the
 * TLS server name. Weaker (it depends on that filter parsing correctly), so a provider offers it
 * only when its operator has opted in, and a caller uses it only when the strict one is not
 * possible (no stable address).
 */
export type EgressPolicy =
  "none" | "open" | "allowlist" | "deny-all-except-proxy" | "proxy-domain-filtered";

/**
 * How strongly a sandbox is separated from the host and from other sandboxes, weakest first.
 * - `container`: processes share the host kernel (Docker, Daytona containers).
 * - `gvisor`: a user-space kernel intercepts system calls (Docker with runsc).
 * - `microvm`: its own kernel in a lightweight VM (Firecracker, Cloud Hypervisor).
 * - `vm`: a full virtual machine.
 * A provider declares only what it has verified; the scheduler enforces minimums by trust class.
 */
export type IsolationClass = "container" | "gvisor" | "microvm" | "vm";

export const ISOLATION_ORDER: readonly IsolationClass[] = ["container", "gvisor", "microvm", "vm"];

/** True when `have` is at least as strong as `need`. */
export function isolationAtLeast(have: IsolationClass, need: IsolationClass): boolean {
  return ISOLATION_ORDER.indexOf(have) >= ISOLATION_ORDER.indexOf(need);
}

export interface ProviderInfo {
  /** Stable provider id, for example `docker`. */
  name: string;
  /** How strongly its sandboxes are isolated. Declare only what is verified. */
  isolation: IsolationClass;
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
  /**
   * The longest a sandbox of this provider lives, in seconds, when it reports one (Daytona: its
   * effective `maxTtlSeconds`). Absent when the provider has no fixed value (Docker).
   */
  ttlSeconds?: number;
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

/**
 * Where the secrets proxy is, for a provider whose sandboxes are on a network the controller does
 * not share (Daytona): a public TLS endpoint. A provider that shares a host with the proxy
 * (Docker) uses `host` and `port` only.
 */
export interface ProxyEndpoint {
  host: string;
  port: number;
  /** The name its certificate is for, sent as the TLS server name. Default `host`. */
  tlsName?: string;
  /**
   * Its stable IPv4 addresses. A provider that filters by address allows exactly these and
   * connects to one of them; without them it filters by `tlsName`.
   */
  addresses?: readonly string[];
}

export interface SandboxNetworkSpec {
  egress: EgressPolicy;
  /**
   * For `deny-all-except-proxy`: where the controller's secrets proxy listens, as the provider's
   * own host sees it (for Docker, `host.docker.internal` and the port). The sandbox can reach the
   * proxy and nothing else; `SandboxHandle.proxy` says how.
   */
  proxy?: ProxyEndpoint;
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
  /** Set for `deny-all-except-proxy`: the proxy address as the sandbox sees it. */
  proxy?: { host: string; port: number };
  /**
   * Set for `deny-all-except-proxy`: `host:port` targets the sandbox must NOT be able to reach (for
   * Docker, the host's address on the sandbox's network), for the caller to verify from inside.
   */
  mustNotReach?: readonly string[];
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

/** Why a `killed` exec was stopped. */
export type ExecReason = "timeout" | "killed" | "output_limit";

export interface ExecStatus {
  state: ExecState;
  /** Set when state is `killed`. */
  reason?: ExecReason;
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

/**
 * A region of output the sandbox dropped (the head and tail caps). It is data, never bytes: the
 * output a job prints can contain any text, so a marker inside the stream could be forged.
 */
export interface ExecCut {
  /** How many bytes of the full output were dropped. */
  omittedBytes: number;
}

export interface ExecLogs {
  /** Output bytes. Empty when this reply is a cut. Never contains a marker for omitted output. */
  bytes: Uint8Array;
  /**
   * Set when the output between `fromOffset` and `nextOffset` was dropped: `nextOffset` is then
   * `fromOffset + omittedBytes`, and the caller records the cut at the position it has reached
   * in what it stored. A reply is either bytes or a cut, never both.
   */
  cut?: ExecCut;
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

/** One readiness finding from a provider, for `turntable doctor`. Never carries a credential. */
export interface ProviderCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  /** A fixed sentence: never carries text from an upstream error. */
  summary: string;
  /** The upstream error text, for the local CLI only; the API never returns it. */
  detail?: string;
  /** What to do about it, when it is not a pass. */
  fix?: string;
}

export interface Provider {
  readonly info: ProviderInfo;
  healthcheck(): Promise<void>;
  /**
   * Read-only readiness checks for an operator before going live: credentials readable, the
   * account reachable, what the provider is configured to start from. It must not create, start,
   * change or delete anything, and must not put a credential in its output.
   */
  diagnose?(): Promise<ProviderCheck[]>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /** Idempotent: a missing sandbox is success. */
  destroy(sandboxId: string): Promise<void>;
  /** Destroys every sandbox whose labels include all of `labels`. Returns how many. */
  destroyByLabels(labels: Labels): Promise<number>;
  list(filter: { labels?: Labels }): Promise<SandboxInfo[]>;
  count(filter: { labels?: Labels }): Promise<number>;
  /**
   * Tells a provider about sandboxes this controller created before it started (read from the
   * attempts that recorded a sandbox and no confirmed destroy), so it counts and cleans them up
   * by id. For a provider whose listings cannot be trusted; others need not implement it. Nothing
   * about the ids is trusted: the provider confirms each before acting on it.
   */
  adopt?(sandboxIds: readonly string[]): void;
  exec: ProviderExec;
  files: ProviderFiles;
}
