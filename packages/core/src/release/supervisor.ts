// The release lane as a supervised child of the main process (option D of
// docs/design/release-lane-hosted.mdx): two processes in one container.
//
//  - `prepareSupervisedLane` runs ONCE, first: it removes every release variable from the parent's
//    environment and builds the child's environment from an explicit allowlist. The parent's
//    `process.env` has none of them from then on.
//  - `LaneSupervisor` starts the child (`serve --roles release`, which never serves the web app),
//    restarts it with backoff, reports its state, and stops it with the parent.
//  - The parent reaches the child only over a unix socket in a 0700 directory, under channel keys
//    it made for this boot: they never touch disk. The parent holds no signer and no master key.
//
// What this does not do: the child runs as the parent's user. See the design doc for what that
// leaves (same-user code can read /proc/<pid>/environ), and docs/release-lane.mdx.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPost } from "@turntable/net";
import {
  RELEASE_CHANNEL_CONFIG_KEY_ENV,
  RELEASE_CHANNEL_KEY_ENV,
  releaseConfigFromEnv,
  takeReleaseEnv,
} from "../roles";
import { channelMac } from "./channel";
import { createChannelClient, createLaneConfigClient } from "./channel-client";
import type { ChannelClient, LaneConfigClient } from "./channel-client";

/** Set to `1` on the main process to run the release lane as its supervised child. Off by default. */
export const LANE_SUPERVISED_ENV = "TURNTABLE_LANE_SUPERVISED";
/** Set by the supervisor in the child's environment: the child exits when its parent does. */
export const LANE_CHILD_ENV = "TURNTABLE_LANE_CHILD";

/**
 * The variables the child gets that are not release-lane variables: a search path, the time zone
 * and the two switches that decide how it drops root. Nothing of the main process's keys, tokens,
 * database URL or provider settings is here, and nothing else is passed.
 */
export const CHILD_PASSTHROUGH_ENV = [
  "PATH",
  "TZ",
  "TURNTABLE_DROP_PRIVILEGES",
  "TURNTABLE_ALLOW_ROOT",
] as const;

/** Variables the supervisor sets itself: the operator must not. */
const DERIVED = [
  "TURNTABLE_RELEASE_CHANNEL_SOCKET",
  "TURNTABLE_RELEASE_CHANNEL_KEY",
  "TURNTABLE_RELEASE_CHANNEL_KEY_FILE",
  "TURNTABLE_RELEASE_CHANNEL_CONFIG_KEY",
  "TURNTABLE_RELEASE_CHANNEL_CONFIG_KEY_FILE",
  "TURNTABLE_RELEASE_CHANNEL_TCP",
] as const;

/** The main process's own view of the channel: set by the supervisor, never by the operator. */
const MAIN_CHANNEL_VARS = [
  "TURNTABLE_PUBLISH_CHANNEL_KEY_FILE",
  "TURNTABLE_PUBLISH_CHANNEL_URL",
  "TURNTABLE_PUBLISH_CHANNEL_SOCKET",
  "TURNTABLE_PUBLISH_CONFIG_KEY_FILE",
] as const;

export function laneSupervised(env: Record<string, string | undefined>): boolean {
  const v = env[LANE_SUPERVISED_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface PreparedLane {
  /** The child's complete environment. Only the supervisor reads it. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** The unix socket the child's channel listens on, in a 0700 directory. */
  readonly socket: string;
  /** The parent's clients of the channel: they hold this boot's keys and nothing of the lane's. */
  readonly channel: ChannelClient;
  readonly config: LaneConfigClient;
  /** The key the health probe uses (the worker's request key). */
  readonly probeKey: string;
  /** Removes the socket directory. */
  cleanup(): void;
}

/**
 * Takes every release variable out of `env` (the parent's process.env) and builds the child's
 * environment. Throws, before anything is spawned, when the lane's configuration is incomplete or
 * the operator set a variable the supervisor owns. `postgres`: the main database is Postgres, so
 * the child needs its own URL (TURNTABLE_RELEASE_DATABASE_URL, ideally a role limited to what the
 * lane reads) and never receives the main one.
 */
export function prepareSupervisedLane(o: {
  env: Record<string, string | undefined>;
  postgres?: boolean;
  /** Directory for the socket directory; the system temporary directory by default. */
  runDir?: string;
}): PreparedLane {
  const mainSet = MAIN_CHANNEL_VARS.filter((k) => o.env[k]?.trim());
  const passthrough: Record<string, string> = {};
  for (const k of CHILD_PASSTHROUGH_ENV) {
    const v = o.env[k];
    if (v !== undefined) passthrough[k] = v;
  }
  // First: the release variables leave this process's environment, whatever happens next.
  const taken = takeReleaseEnv(o.env);
  if (mainSet.length > 0) {
    throw new Error(
      `${LANE_SUPERVISED_ENV} is set, so the channel to the lane is made at boot: unset ${mainSet.join(", ")}`,
    );
  }
  const derived = DERIVED.filter((k) => taken[k] !== undefined);
  if (derived.length > 0) {
    throw new Error(
      `${LANE_SUPERVISED_ENV} is set, so the supervisor makes the channel: unset ${derived.join(", ")}`,
    );
  }
  const requestKey = randomBytes(32).toString("hex");
  const configKey = randomBytes(32).toString("hex");
  const dir = mkdtempSync(join(o.runDir ?? tmpdir(), "tt-lane-")); // mode 0700
  const socket = join(dir, "channel.sock");
  const childEnv: Record<string, string> = {
    ...passthrough,
    ...taken,
    [LANE_CHILD_ENV]: "1",
    // The release proxy is what the channel serves. Loopback only, any free port, unless asked otherwise.
    TURNTABLE_RELEASE_PROXY_PORT: taken.TURNTABLE_RELEASE_PROXY_PORT?.trim() || "0",
    TURNTABLE_RELEASE_CHANNEL_SOCKET: socket,
    [RELEASE_CHANNEL_KEY_ENV]: requestKey,
    [RELEASE_CHANNEL_CONFIG_KEY_ENV]: configKey,
  };
  const dbUrl = taken.TURNTABLE_RELEASE_DATABASE_URL?.trim();
  if (dbUrl) childEnv.TURNTABLE_DATABASE_URL = dbUrl;
  try {
    if (o.postgres && !dbUrl) {
      throw new Error(
        "the main database is Postgres: the lane needs its own connection, TURNTABLE_RELEASE_DATABASE_URL (the main URL is never passed to it)",
      );
    }
    // The same parse the child will do, on a copy: a bad setting stops the boot here.
    releaseConfigFromEnv({ ...childEnv });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const target = { unix: socket };
  return {
    childEnv,
    socket,
    probeKey: requestKey,
    channel: createChannelClient({ target, key: requestKey }),
    config: createLaneConfigClient({ target, key: configKey }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type LaneState = "starting" | "ready" | "restarting" | "stopped";

export interface LaneStatus {
  state: LaneState;
  /** How many times the child was started again after it exited. */
  restarts: number;
  /** The child's process id while it runs (not a secret). */
  pid?: number | undefined;
  lastExit?: { code: number | null; signal: string | null; at: number } | undefined;
  /** When the current state began. */
  since: number;
}

export type LaneAvailability =
  { ok: true } | { ok: false; code: "release_lane_unavailable"; state: LaneState; message: string };

export interface LaneProcess {
  pid: number | undefined;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}
export type LaneSpawner = (argv: string[], env: Record<string, string>) => LaneProcess;

/** This binary, run again: the compiled binary, or `bun <script>` in development. */
export function selfCommand(): string[] {
  const script = process.argv[1];
  return script && existsSync(script) ? [process.execPath, script] : [process.execPath];
}

/** Spawns with an explicit environment: Bun.spawn's `env` replaces, never extends, the parent's. */
export const spawnLane: LaneSpawner = (argv, env) => {
  const p = Bun.spawn(argv, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return {
    pid: p.pid,
    exited: p.exited.then((code) => ({ code, signal: (p.signalCode as string | null) ?? null })),
    kill: (s) => void p.kill(s),
  };
};

export interface SupervisorOptions {
  prepared: Pick<PreparedLane, "childEnv" | "socket" | "probeKey" | "cleanup">;
  /** The child's command line after the binary: `serve --roles release --data-dir <dir>`. */
  args: string[];
  command?: string[];
  spawn?: LaneSpawner;
  /** True once the child's channel answers. Default: a signed health request over the socket. */
  probe?: () => Promise<boolean>;
  log?: (m: string) => void;
  now?: () => number;
  backoff?: { baseMs: number; maxMs: number; stableMs: number };
  readyPollMs?: number;
  stopGraceMs?: number;
}

export class LaneSupervisor {
  private state: LaneState = "starting";
  private since: number;
  private restarts = 0;
  private lastExit: LaneStatus["lastExit"];
  private stopping = false;
  private proc: LaneProcess | undefined;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly spawnFn: LaneSpawner;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly backoff: { baseMs: number; maxMs: number; stableMs: number };

  private readonly o: SupervisorOptions;

  constructor(o: SupervisorOptions) {
    this.o = o;
    this.spawnFn = o.spawn ?? spawnLane;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[turntable] ${m}`));
    this.backoff = o.backoff ?? { baseMs: 1000, maxMs: 30_000, stableMs: 60_000 };
    this.since = this.now();
  }

  status(): LaneStatus {
    return {
      state: this.state,
      restarts: this.restarts,
      pid: this.proc?.pid,
      lastExit: this.lastExit,
      since: this.since,
    };
  }

  /** Whether a release request can be taken now. A named error when it cannot. */
  availability(): LaneAvailability {
    if (this.state === "ready") return { ok: true };
    return {
      ok: false,
      code: "release_lane_unavailable",
      state: this.state,
      message:
        this.state === "restarting"
          ? "the release lane stopped and is restarting; try again shortly"
          : this.state === "starting"
            ? "the release lane is starting; try again shortly"
            : "the release lane is stopped",
    };
  }

  start(): void {
    if (this.loop) return;
    // A parent that dies without stopping the child must not leave a signer running.
    process.once("exit", () => this.proc?.kill("SIGKILL"));
    this.loop = this.run();
  }

  private set(state: LaneState): void {
    this.state = state;
    this.since = this.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async probe(): Promise<boolean> {
    if (this.o.probe) return this.o.probe();
    const ts = this.now();
    try {
      const r = await controlPost(
        { unix: this.o.prepared.socket },
        "/v1/health",
        { ts, mac: channelMac(this.o.prepared.probeKey, "health", [], ts) },
        { timeoutMs: 2000 },
      );
      return r.status === 200;
    } catch {
      return false;
    }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    const command = this.o.command ?? selfCommand();
    while (!this.stopping) {
      this.set("starting");
      const proc = this.spawnFn([...command, ...this.o.args], { ...this.o.prepared.childEnv });
      this.proc = proc;
      let alive = true;
      let readyAt: number | undefined;
      const exit = proc.exited.finally(() => (alive = false));
      this.log(`release lane started (pid ${proc.pid ?? "?"})`);
      void (async () => {
        while (alive && !this.stopping) {
          if (await this.probe()) {
            if (alive && !this.stopping) {
              readyAt = this.now();
              this.set("ready");
            }
            return;
          }
          await this.sleep(this.o.readyPollMs ?? 200);
        }
      })();
      const code = await exit.catch(() => ({ code: null, signal: null }));
      this.proc = undefined;
      if (this.stopping) break;
      this.lastExit = { ...code, at: this.now() };
      this.set("restarting");
      this.log(
        `release lane exited (code ${code.code ?? "none"}, signal ${code.signal ?? "none"}); release requests are refused until it is back`,
      );
      // A lane that ran steadily starts again at once; one that keeps failing waits longer.
      if (readyAt !== undefined && this.now() - readyAt >= this.backoff.stableMs) attempt = 0;
      const wait = Math.min(this.backoff.baseMs * 2 ** attempt, this.backoff.maxMs);
      attempt++;
      await this.sleep(wait);
      if (!this.stopping) this.restarts++;
    }
    this.set("stopped");
  }

  /** Stops the child with the parent: SIGTERM, then SIGKILL after the grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    const proc = this.proc;
    if (proc) {
      proc.kill("SIGTERM");
      const done = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), this.o.stopGraceMs ?? 10_000)),
      ]);
      if (!done) proc.kill("SIGKILL");
    }
    await this.loop;
    this.o.prepared.cleanup();
  }
}
