import type { SafeFetch } from "@longshore/net";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  createWrappedExec,
  readCapped,
  shellQuote,
  type Labels,
  type Provider,
  type ProviderInfo,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxSpec,
  type ShellRunner,
  type WrappedExecOptions,
} from "@longshore/provider-sdk";
import { type DaytonaSandbox, DaytonaApi, DEFAULT_BASE_URL, readJson } from "./api";
import type { ApiKeySource } from "./key";
import {
  DEFAULT_ORG_CLASS,
  DEFAULT_ORG_CPU_LIMIT,
  DEFAULT_ORG_REGION,
  FOREIGN_WAIT_AT,
  cpuInUse,
  type OwnerCiPreflight,
  type RegionUsageRow,
  LIVE_STATES,
  MAX_TTL_SECONDS,
  OWN_LABEL,
  OWN_LABEL_VALUE,
  RUN_LABEL,
  clampMaxLive,
  isForeignCi,
  isLive,
  isOwn,
  ownName,
} from "./policy";

export type UsageRecord = {
  sandboxId: string;
  name: string;
  /** Epoch ms from Daytona's createdAt (or our create call when missing). */
  createdAt: number;
  destroyedAt: number;
  seconds: number;
};

export interface DaytonaProviderOptions {
  /** Where to read the API key at runtime: a file path, an env var name, or a function. */
  apiKey: ApiKeySource;
  baseUrl?: string;
  /** Run id stamped on every sandbox as the `longshore-run` label unless the spec already has one. */
  runId?: string;
  /** Live sandboxes of ours at once. Default 2, never above 3. */
  maxLive?: number;
  /** Daytona target (region). Omit for the account default. */
  target?: string;
  /**
   * Name of an EXISTING snapshot to start from. This provider never creates snapshots. When a
   * spec also names an `image` (the scheduler always does), the snapshot is used and the image
   * name is ignored: the operator chose what runs, and an image build would create a snapshot.
   * With no snapshot (and no `allowImageBuild`), the image name is ignored too and Daytona starts
   * from the account's default snapshot.
   */
  snapshot?: string;
  /**
   * Allow `spec.image` by asking Daytona to build it. A build creates a snapshot in the account,
   * which the customer-account rules forbid, so it is off by default and must be switched on
   * deliberately.
   */
  allowImageBuild?: boolean;
  /** Longest TTL a sandbox may have, in seconds. Default and ceiling: 1800 (30 minutes). */
  maxTtlSeconds?: number;
  /**
   * What to do with a spec asking for more than `maxTtlSeconds`: refuse it (default, the safe
   * choice for library use) or clamp it, so a scheduler that asks for job timeout plus slack
   * still runs, with the sandbox reaped at the cap.
   */
  clampTtl?: boolean;
  /** Per-file byte cap. Default 64 MiB. */
  maxFileBytes?: number;
  exec?: WrappedExecOptions;
  /** How long to wait for capacity (our own cap or the owner's CI) before giving up. Default 20 min. */
  capacityWaitMs?: number;
  /**
   * The org-wide CPU check before each create (see OwnerCiPreflight). On by default with the
   * defaults; `false` turns it off. If the account has no sandbox to learn the org id from, or the
   * usage endpoint does not exist (404), the check is skipped and the label count still applies.
   */
  ownerCiPreflight?: OwnerCiPreflight | false;
  /** Poll interval while waiting for capacity or for a sandbox to start. Default 5 s. */
  pollMs?: number;
  /** How long a sandbox may take to reach `started`. Default 3 min. */
  startTimeoutMs?: number;
  /** Called after a sandbox is deleted, so callers can account for minutes used. */
  onUsage?: (r: UsageRecord) => void;
  /** Debug log (retries, with the call and attempt; never a URL with a token). Default silent. */
  log?: (message: string) => void;
  fetch?: SafeFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const dec = new TextDecoder();

/** Cap on one exec reply from the sandbox (framed, base64). */
const EXEC_REPLY_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs argv inside the sandbox and returns binary-safe stdout, stderr and the exit code. Daytona's
 * execute call returns one text string, so the command writes each stream to a temp file and
 * prints them base64-encoded between markers.
 */
const FRAME_SH =
  'O=$(mktemp) || exit 125; E=$(mktemp) || exit 125; "$@" >"$O" 2>"$E" </dev/null; C=$?; ' +
  'echo "tt-ec $C"; echo tt-out; base64 <"$O" | tr -d "\\n"; echo; echo tt-err; base64 <"$E" | tr -d "\\n"; echo; ' +
  'rm -f "$O" "$E"';

function unframe(result: string): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } {
  const lines = result.split("\n");
  const ec = lines.findIndex((l) => l.startsWith("tt-ec "));
  const out = lines.indexOf("tt-out", ec);
  const err = lines.indexOf("tt-err", out);
  if (ec < 0 || out < 0 || err < 0)
    throw new InfraError("Daytona exec: unexpected reply from the sandbox");
  const code = Number(lines[ec]!.slice(6));
  if (!Number.isInteger(code)) throw new InfraError("Daytona exec: bad exit code in reply");
  const b64 = (s: string | undefined): Uint8Array =>
    Uint8Array.from(Buffer.from(s ?? "", "base64"));
  return { exitCode: code, stdout: b64(lines[out + 1]), stderr: b64(lines[err + 1]) };
}

export class DaytonaProvider implements Provider {
  readonly info: ProviderInfo;
  readonly exec: Provider["exec"];
  readonly files: Provider["files"];
  /** Verified ids -> toolbox base URL. Only sandboxes proven to be ours are ever acted on. */
  private readonly known = new Map<string, string>();
  private readonly api: DaytonaApi;
  private readonly runId: string;
  private readonly maxLive: number;
  private readonly maxFileBytes: number;
  private readonly maxTtl: number;
  private readonly capacityWaitMs: number;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Serialises create() so the capacity check and the create cannot interleave in this process. */
  private createChain: Promise<unknown> = Promise.resolve();

  private readonly opts: DaytonaProviderOptions;

  constructor(opts: DaytonaProviderOptions) {
    this.opts = opts;
    this.api = new DaytonaApi({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.runId = opts.runId ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    this.maxLive = clampMaxLive(opts.maxLive);
    const ttl = opts.maxTtlSeconds ?? MAX_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
      throw new RangeError(`maxTtlSeconds must be 60 to ${MAX_TTL_SECONDS}`);
    }
    this.maxTtl = ttl;
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024 * 1024;
    this.capacityWaitMs = opts.capacityWaitMs ?? 20 * 60_000;
    this.pollMs = opts.pollMs ?? 5000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 180_000;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = opts.now ?? Date.now;

    // Declared only what has been exercised against the real service (see docs/providers.mdx).
    this.info = {
      name: "daytona",
      // Verified live: sandboxes report `sandboxClass: container`. The `linux-vm` class exists but
      // has not been exercised, so no stronger level is claimed.
      isolation: "container",
      createFrom: ["snapshot"],
      exec: { detached: true, logsByOffset: true, streaming: false, tty: false },
      files: { upload: true, download: true, maxBytes: this.maxFileBytes },
      network: { egressPolicy: ["none", "open"], ingress: false, proxyReachability: false },
      resources: { cpus: true, memoryMb: true, diskGb: true },
      ttl: true,
      labels: true,
      list: true,
      listByLabel: true,
      os: ["linux"],
      arch: ["amd64"],
      cost: "none",
    };

    const runner: ShellRunner = {
      run: async (id, argv, { timeoutMs }) => {
        const base = await this.toolbox(id);
        const command = `sh -c ${shellQuote(FRAME_SH)} tt ${argv.map(shellQuote).join(" ")}`;
        const res = await this.toolboxCall(id, base, "POST", "/process/execute", {
          json: { command, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)) },
          timeoutMs: timeoutMs + 15_000,
        });
        // An exec reply is a framed, base64 copy of at most a log chunk; bound it regardless.
        const body = await readJson<{ exitCode?: number; result?: string }>(
          res,
          EXEC_REPLY_MAX_BYTES,
        );
        if (typeof body.result !== "string") throw new InfraError("Daytona exec: empty reply");
        return unframe(body.result);
      },
    };
    // The toolbox is slow to answer while a heavy job runs, so a status or log read gets longer than
    // the generic default before it counts as a timeout, and a transient failure of one is retried
    // for a few minutes (never the launch itself without checking: see wrapped-exec).
    this.exec = createWrappedExec(runner, {
      commandTimeoutMs: 120_000,
      ...opts.exec,
      retry: {
        sleep: this.sleep,
        now: this.now,
        onRetry: (what, attempt, error) =>
          opts.log?.(`daytona ${what}: attempt ${attempt} failed, retrying: ${error.message}`),
        ...opts.exec?.retry,
      },
    });

    this.files = {
      put: async (id, path, bytes) => {
        if (bytes.length > this.maxFileBytes) {
          throw new FileTooLargeError(`${bytes.length} bytes exceeds ${this.maxFileBytes}`);
        }
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
        const mk = await runner.run(id, ["mkdir", "-p", dir], { timeoutMs: 30_000 });
        if (mk.exitCode !== 0)
          throw new SpecError(`put: cannot create ${dir}: ${dec.decode(mk.stderr).trim()}`);
        const base = await this.toolbox(id);
        const form = new FormData();
        form.set("file", new Blob([bytes as unknown as ArrayBuffer]), "upload");
        await this.toolboxCall(id, base, "POST", "/files/upload-v2", {
          query: { path },
          form,
          timeoutMs: 120_000,
        });
      },
      get: async (id, path, maxBytes) => {
        const base = await this.toolbox(id);
        let res: Response;
        try {
          res = await this.toolboxCall(id, base, "GET", "/files/download", {
            query: { path },
            timeoutMs: 120_000,
          });
        } catch (e) {
          // A 404 here can mean the file, not the sandbox: tell them apart.
          if (e instanceof SandboxNotFoundError) {
            await this.verify(id, true);
            throw new SpecError(`get: no such file: ${path}`);
          }
          throw e;
        }
        // Stream with a running count: a big or lying response never gets buffered past maxBytes.
        return readCapped(res, maxBytes);
      },
    };
  }

  // ---- ownership ----

  /**
   * Proves a sandbox is ours (label and name prefix) before anything is done to it, and returns
   * its toolbox URL. A missing sandbox throws SandboxNotFoundError; a foreign one SpecError.
   */
  private async verify(id: string, fresh = false): Promise<string> {
    const cached = this.known.get(id);
    if (cached && !fresh) return cached;
    const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
    if (!isOwn(sb)) {
      throw new SpecError(
        `refusing to touch sandbox ${id}: it is not labelled ${OWN_LABEL}=${OWN_LABEL_VALUE}`,
      );
    }
    if (!sb.toolboxProxyUrl) throw new InfraError("Daytona sandbox has no toolbox URL");
    const base = `${sb.toolboxProxyUrl.replace(/\/+$/, "")}/${encodeURIComponent(sb.id)}`;
    this.known.set(id, base);
    return base;
  }

  private async toolbox(id: string): Promise<string> {
    return this.verify(id);
  }

  private async toolboxCall(
    id: string,
    base: string,
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData; query?: Record<string, string>; timeoutMs: number },
  ): Promise<Response> {
    try {
      return await this.api.request(method, `${base}${path}`, init);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) {
        // The toolbox said 404: the sandbox itself may be gone. Re-check before saying so.
        this.known.delete(id);
        await this.verify(id);
      }
      throw e;
    }
  }

  // ---- capacity ----

  private async listAll(
    query: Record<string, string | readonly string[] | undefined>,
  ): Promise<DaytonaSandbox[]> {
    const out: DaytonaSandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const r = await this.api.json<{ items?: DaytonaSandbox[]; nextCursor?: string | null }>(
        "GET",
        "/sandbox",
        {
          query: { limit: 200, ...query, ...(cursor ? { cursor } : {}) },
        },
      );
      out.push(...(r.items ?? []));
      if (!r.nextCursor) return out;
      cursor = r.nextCursor;
    }
    throw new InfraError("Daytona: sandbox listing did not end");
  }

  private async ownLive(): Promise<number> {
    const all = await this.listAll({ labels: JSON.stringify({ [OWN_LABEL]: OWN_LABEL_VALUE }) });
    return all.filter((s) => isOwn(s) && isLive(s.state)).length;
  }

  /**
   * Counts the owner's own CI sandboxes that hold quota. Read only: they are never touched.
   * Only the states that hold quota are fetched, because an account can hold thousands of
   * stopped or archived sandboxes that use none.
   */
  private async foreignLive(): Promise<number> {
    const live = await this.listAll({ states: LIVE_STATES });
    return live.filter((s) => !isOwn(s) && isForeignCi(s)).length;
  }

  private orgId: string | undefined;
  private warnedNoOrg = false;

  /**
   * The org's CPU in use against the limit: `{ ok: true }` when there is room for `vcpu` more (or
   * the check does not apply), else the reading. Reading errors are thrown: an unreadable usage is
   * never taken for room.
   */
  private async orgRoom(
    vcpu: number,
  ): Promise<{ ok: true } | { ok: false; cpu: number; limit: number }> {
    const o = this.opts.ownerCiPreflight;
    if (o === false) return { ok: true };
    const limit = o?.cpuLimit ?? DEFAULT_ORG_CPU_LIMIT;
    if (this.orgId === undefined) {
      const first = await this.api.json<{ items?: DaytonaSandbox[] }>("GET", "/sandbox", {
        query: { limit: 1 },
        timeoutMs: 20_000,
      });
      this.orgId = first.items?.find((s) => s.organizationId)?.organizationId;
    }
    // Nothing to learn the org from: an empty account has nobody else in it. The first sandbox we
    // create tells us the org id for the next create.
    if (this.orgId === undefined) {
      if (!this.warnedNoOrg) {
        this.warnedNoOrg = true;
        this.opts.log?.(
          "daytona: no sandbox in the account to learn the org id from, so the org usage check is skipped for this create",
        );
      }
      return { ok: true };
    }
    let usage: { regionUsage?: RegionUsageRow[] };
    try {
      usage = await this.api.json("GET", `/organizations/${encodeURIComponent(this.orgId)}/usage`, {
        timeoutMs: 20_000,
      });
    } catch (e) {
      // Fail closed: a check that cannot be made is not a check that passed. An operator whose
      // deployment has no usage endpoint opts out with `ownerCiPreflight: false`.
      if (e instanceof SandboxNotFoundError) {
        throw new InfraError(
          "Daytona's org usage endpoint answered 404, so the org's CPU cannot be checked; not creating a sandbox (set ownerCiPreflight: false to run without the check)",
        );
      }
      throw e;
    }
    const cpu = cpuInUse(
      usage.regionUsage,
      o?.region ?? DEFAULT_ORG_REGION,
      o?.sandboxClass ?? DEFAULT_ORG_CLASS,
    );
    if (cpu === undefined) throw new InfraError("Daytona usage reply has no CPU reading");
    return cpu + vcpu <= limit ? { ok: true } : { ok: false, cpu, limit };
  }

  /** Waits until we are under our own cap and the owner's CI is not busy, or gives up. */
  private async waitForCapacity(vcpu = 1): Promise<void> {
    const deadline = this.now() + this.capacityWaitMs;
    for (;;) {
      const [own, foreign, room] = await Promise.all([
        this.ownLive(),
        this.foreignLive(),
        this.orgRoom(vcpu),
      ]);
      if (own < this.maxLive && foreign < FOREIGN_WAIT_AT && room.ok) return;
      if (this.now() >= deadline) {
        if (!room.ok && own < this.maxLive && foreign < FOREIGN_WAIT_AT) {
          throw new InfraError(
            `waited ${Math.round(this.capacityWaitMs / 1000)}s: the org has ${room.cpu} vCPU in use (waiting above ${room.limit}, this sandbox needs ${vcpu})`,
          );
        }
        throw new InfraError(
          own >= this.maxLive
            ? `waited ${Math.round(this.capacityWaitMs / 1000)}s: already ${own} live sandboxes of ours (max ${this.maxLive})`
            : `waited ${Math.round(this.capacityWaitMs / 1000)}s: the account's CI has ${foreign} live sandboxes (waiting at ${FOREIGN_WAIT_AT})`,
        );
      }
      await this.sleep(this.pollMs);
    }
  }

  // ---- Provider ----

  async healthcheck(): Promise<void> {
    await this.api.json("GET", "/sandbox", { query: { limit: 1 }, timeoutMs: 20_000 });
  }

  /** Validates a spec against the account rules and builds the Daytona request body. */
  buildCreateBody(spec: SandboxSpec): Record<string, unknown> {
    if (!Number.isInteger(spec.ttlSeconds) || spec.ttlSeconds <= 0) {
      throw new SpecError("ttlSeconds must be a positive integer");
    }
    if (spec.ttlSeconds > this.maxTtl && !this.opts.clampTtl) {
      throw new SpecError(
        `ttlSeconds ${spec.ttlSeconds} exceeds the ${this.maxTtl}s limit for this account`,
      );
    }
    const ttlSeconds = Math.min(spec.ttlSeconds, this.maxTtl);
    if (spec.network.egress !== "none" && spec.network.egress !== "open") {
      throw new SpecError(
        `egress policy ${spec.network.egress} is not supported by this provider (none, open)`,
      );
    }
    if (spec.template !== undefined)
      throw new SpecError("templates are not supported by this provider");
    const labels: Record<string, string> = { ...spec.labels };
    if (labels[OWN_LABEL] !== undefined && labels[OWN_LABEL] !== OWN_LABEL_VALUE) {
      throw new SpecError(`the ${OWN_LABEL} label is reserved`);
    }
    labels[OWN_LABEL] = OWN_LABEL_VALUE;
    labels[RUN_LABEL] = labels[RUN_LABEL] || this.runId;

    const minutes = Math.ceil(ttlSeconds / 60);
    const body: Record<string, unknown> = {
      name: ownName(spec.name),
      labels,
      public: false,
      networkBlockAll: spec.network.egress === "none",
      // Three independent backstops, all within the limit: hard wall-clock TTL, auto-stop when
      // idle, and delete the moment it stops. No env field exists on a spec, so none is sent.
      ttlMinutes: minutes,
      autoStopInterval: minutes,
      autoDeleteInterval: 0,
    };
    if (this.opts.target) body.target = this.opts.target;
    const r = spec.resources;
    if (r?.cpus !== undefined) body.cpu = r.cpus;
    if (r?.memoryMb !== undefined) body.memory = Math.max(1, Math.ceil(r.memoryMb / 1024));
    if (r?.diskGb !== undefined) body.disk = r.diskGb;

    // Which image the sandbox starts from, in order: a named snapshot (the spec's, else the
    // configured one: the operator chose what runs, so an `image` name the scheduler adds is
    // ignored); an image build, only when explicitly allowed; otherwise neither field is sent and
    // Daytona starts from the account's default snapshot. No snapshot is ever created by default.
    const snapshot = spec.snapshot ?? this.opts.snapshot;
    if (snapshot !== undefined) {
      body.snapshot = snapshot;
    } else if (spec.image !== undefined && this.opts.allowImageBuild) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(spec.image))
        throw new SpecError("invalid image reference");
      body.buildInfo = { dockerfileContent: `FROM ${spec.image}\n` };
    }
    return body;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const body = this.buildCreateBody(spec); // refuse a bad spec before queueing anything
    const run = async (): Promise<SandboxHandle> => {
      await this.waitForCapacity(spec.resources?.cpus ?? 1);
      const startedAt = this.now();
      const sb = await this.api.json<DaytonaSandbox>("POST", "/sandbox", {
        json: body,
        timeoutMs: 120_000,
      });
      try {
        if (!isOwn(sb))
          throw new InfraError("Daytona created a sandbox without our label; refusing to continue");
        // The org id for the next create's usage check, when the account had no sandbox to ask.
        this.orgId ??= sb.organizationId;
        await this.waitStarted(sb.id);
        const base = await this.verify(sb.id, true);
        await this.waitToolbox(sb.id, base);
        // Listings lag behind creation. Wait until it shows up, so counts, caps and
        // destroyByLabels see this sandbox as soon as create returns.
        await this.waitListed(sb.id, true);
        return { id: sb.id, startedAt };
      } catch (e) {
        // Never leave a half-created sandbox behind.
        await this.api.json("DELETE", `/sandbox/${encodeURIComponent(sb.id)}`).catch(() => {});
        this.known.delete(sb.id);
        throw e;
      }
    };
    const next = this.createChain.then(run, run);
    this.createChain = next.catch(() => {});
    return next;
  }

  private async waitStarted(id: string): Promise<void> {
    const deadline = this.now() + this.startTimeoutMs;
    for (;;) {
      const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
      if (sb.state === "started") return;
      if (sb.state === "error" || sb.state === "build_failed" || sb.state === "destroyed") {
        throw new InfraError(
          `Daytona sandbox failed to start (${sb.state}${sb.errorReason ? `: ${sb.errorReason}` : ""})`,
        );
      }
      if (this.now() >= deadline)
        throw new InfraError(
          `Daytona sandbox did not start within ${this.startTimeoutMs} ms (${sb.state})`,
        );
      await this.sleep(Math.min(this.pollMs, 2000));
    }
  }

  private async waitToolbox(id: string, base: string): Promise<void> {
    const deadline = this.now() + 60_000;
    for (;;) {
      try {
        const res = await this.toolboxCall(id, base, "POST", "/process/execute", {
          json: { command: "true", timeout: 10 },
          timeoutMs: 20_000,
        });
        await readCapped(res, 64 * 1024);
        return;
      } catch (e) {
        if (e instanceof SandboxNotFoundError || e instanceof SpecError) throw e;
        if (this.now() >= deadline) throw e;
        await this.sleep(1000);
      }
    }
  }

  async destroy(id: string): Promise<void> {
    let sb: DaytonaSandbox;
    try {
      sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof SandboxNotFoundError) return;
      throw e;
    }
    if (!isOwn(sb)) {
      throw new SpecError(
        `refusing to delete sandbox ${id}: it is not labelled ${OWN_LABEL}=${OWN_LABEL_VALUE}`,
      );
    }
    try {
      await this.api.json("DELETE", `/sandbox/${encodeURIComponent(id)}`);
    } catch (e) {
      if (!(e instanceof SandboxNotFoundError)) throw e;
    }
    this.known.delete(id);
    await this.waitGone(id);
    await this.waitListed(id, false);
    const destroyedAt = this.now();
    const createdAt = sb.createdAt ? Date.parse(sb.createdAt) : destroyedAt;
    this.opts.onUsage?.({
      sandboxId: id,
      name: sb.name,
      createdAt,
      destroyedAt,
      seconds: Math.max(0, Math.round((destroyedAt - createdAt) / 1000)),
    });
  }

  /** Listings are eventually consistent: wait until `id` is (or is no longer) in our own listing. */
  private async waitListed(id: string, present: boolean): Promise<void> {
    const deadline = this.now() + 90_000;
    for (;;) {
      const all = await this.listAll({ labels: JSON.stringify({ [OWN_LABEL]: OWN_LABEL_VALUE }) });
      const here = all.some((s) => s.id === id && isOwn(s) && isLive(s.state));
      if (here === present) return;
      if (this.now() >= deadline) {
        throw new InfraError(
          `Daytona listing did not ${present ? "show" : "drop"} sandbox ${id} within 90 s`,
        );
      }
      await this.sleep(Math.min(this.pollMs, 500));
    }
  }

  /** Deletion is asynchronous: wait until the sandbox is really gone so counts and caps are true. */
  private async waitGone(id: string): Promise<void> {
    const deadline = this.now() + 120_000;
    for (;;) {
      try {
        const sb = await this.api.json<DaytonaSandbox>("GET", `/sandbox/${encodeURIComponent(id)}`);
        if (sb.state === "destroyed") return;
      } catch (e) {
        if (e instanceof SandboxNotFoundError) return;
        throw e;
      }
      if (this.now() >= deadline)
        throw new InfraError(`Daytona sandbox ${id} is still being deleted after 120 s`);
      await this.sleep(Math.min(this.pollMs, 500));
    }
  }

  async destroyByLabels(labels: Labels): Promise<number> {
    if (Object.keys(labels).length === 0) throw new SpecError("destroyByLabels needs labels");
    const found = await this.list({ labels });
    for (const s of found) await this.destroy(s.id);
    return found.length;
  }

  async list(filter: { labels?: Labels }): Promise<SandboxInfo[]> {
    // Our own label is always part of the query and is checked again on every result, so a
    // listing can never include (and a delete can never reach) a sandbox that is not ours.
    const want = { ...filter.labels, [OWN_LABEL]: OWN_LABEL_VALUE };
    const all = await this.listAll({ labels: JSON.stringify(want) });
    return all
      .filter(
        (s) =>
          isOwn(s) &&
          isLive(s.state) &&
          Object.entries(want).every(([k, v]) => s.labels?.[k] === v),
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        labels: s.labels ?? {},
        createdAt: s.createdAt ? Date.parse(s.createdAt) : 0,
      }));
  }

  async count(filter: { labels?: Labels }): Promise<number> {
    return (await this.list(filter)).length;
  }
}

/** Creates a sandbox, runs `fn`, and always deletes the sandbox, even when `fn` throws. */
export async function withSandbox<T>(
  provider: Provider,
  spec: SandboxSpec,
  fn: (sandboxId: string) => Promise<T>,
): Promise<T> {
  const { id } = await provider.create(spec);
  try {
    return await fn(id);
  } finally {
    await provider.destroy(id);
  }
}
