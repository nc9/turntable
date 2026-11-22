import { SandboxNotFoundError, InfraError, SpecError } from "./errors";
import { OUTPUT_HEAD_BYTES, OUTPUT_SLACK_BYTES, OUTPUT_TAIL_BYTES, cutMarker } from "./cap-output";
import type {
  ExecLogs,
  ExecLogsOptions,
  ExecReason,
  ExecStartOptions,
  ExecStatus,
  KillSignal,
  ProviderExec,
} from "./types";
import { KILL_SH, LAUNCH_SH, LOGS_SH, STATUS_SH, WRAPPER_SH } from "./wrapper";

/** A short blocking command inside a sandbox. The only primitive a provider must supply. */
export interface ShellRunner {
  /**
   * Runs argv to completion and returns its result. Must NOT inject any env. Must throw
   * SandboxNotFoundError when the sandbox is gone and InfraError on transport trouble.
   * The SDK only runs commands that finish in seconds, so a dropped connection is cheap.
   */
  run(
    sandboxId: string,
    argv: readonly string[],
    opts: { timeoutMs: number },
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
}

export interface WrappedExecOptions {
  /** Where exec dirs live inside the sandbox. */
  baseDir?: string;
  /** Kill the command once its output file exceeds this many bytes. Default 1 GiB. */
  maxOutputBytes?: number;
  head?: number;
  tail?: number;
  slack?: number;
  /** Watchdog tick (size check) in seconds. Default 5. */
  tickSeconds?: number;
  /** Heartbeat is written every this many ticks. Default 6, so about every 30 s. */
  heartbeatEveryTicks?: number;
  /** Client-side timeout for each helper command. Default 60 s. */
  commandTimeoutMs?: number;
}

export const DEFAULT_EXEC_BASE_DIR = "/tmp/.longshore";
const EXEC_ID_RE = /^tt1-[0-9a-f]{24}$/;

/**
 * An execId is `tt1-<24 hex>`. `tt1` is the wrapper layout version; the dir is
 * `<base>/<execId>`, with a base fixed per provider. Nothing else is needed to find the exec, so
 * any provider instance, including one created after a controller restart, can resolve it.
 */
export function newExecId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return "tt1-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function assertExecId(execId: string): void {
  if (!EXEC_ID_RE.test(execId)) throw new SpecError(`malformed execId: ${JSON.stringify(execId)}`);
}

/** POSIX single-quote quoting. */
export function shellQuote(s: string): string {
  if (s.includes("\0")) throw new SpecError("argument contains NUL");
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

export function buildCmdScript(opts: Pick<ExecStartOptions, "argv" | "cwd">): string {
  if (opts.argv.length === 0) throw new SpecError("argv is empty");
  const exec = "exec " + opts.argv.map(shellQuote).join(" ");
  if (opts.cwd === undefined) return exec;
  return `cd ${shellQuote(opts.cwd)} || exit 126\n${exec}`;
}

const SIGNALS: readonly KillSignal[] = ["TERM", "KILL", "INT", "HUP", "QUIT", "USR1", "USR2"];
const dec = new TextDecoder();

function splitHeader(out: Uint8Array): { header: string; body: Uint8Array } {
  const nl = out.indexOf(0x0a);
  if (nl < 0) throw new InfraError("logs: no header in sandbox reply");
  return { header: dec.decode(out.subarray(0, nl)), body: out.subarray(nl + 1) };
}

/** Builds a ProviderExec from a ShellRunner. Stateless: safe to construct per call. */
export function createWrappedExec(runner: ShellRunner, o: WrappedExecOptions = {}): ProviderExec {
  const base = o.baseDir ?? DEFAULT_EXEC_BASE_DIR;
  const head = o.head ?? OUTPUT_HEAD_BYTES;
  const tail = o.tail ?? OUTPUT_TAIL_BYTES;
  const slack = o.slack ?? OUTPUT_SLACK_BYTES;
  const timeoutMs = o.commandTimeoutMs ?? 60_000;
  const dirOf = (execId: string): string => {
    assertExecId(execId);
    return `${base}/${execId}`;
  };
  const sh = (
    id: string,
    script: string,
    args: readonly string[],
  ): ReturnType<ShellRunner["run"]> =>
    runner.run(id, ["sh", "-c", script, "tt", ...args], { timeoutMs });

  return {
    async start(id, opts) {
      if (!Number.isInteger(opts.timeoutSeconds) || opts.timeoutSeconds <= 0) {
        throw new SpecError("timeoutSeconds must be a positive integer");
      }
      const execId = newExecId();
      const res = await sh(id, LAUNCH_SH, [
        dirOf(execId),
        buildCmdScript(opts),
        WRAPPER_SH,
        String(opts.timeoutSeconds),
        String(o.maxOutputBytes ?? 1024 ** 3),
        String(head),
        String(tail),
        String(slack),
        String(o.tickSeconds ?? 5),
        String(o.heartbeatEveryTicks ?? 6),
      ]);
      if (res.exitCode !== 0) {
        throw new InfraError(`exec launch failed (${res.exitCode}): ${dec.decode(res.stderr)}`);
      }
      return { execId };
    },

    async status(id, execId): Promise<ExecStatus> {
      let res;
      try {
        res = await sh(id, STATUS_SH, [dirOf(execId)]);
      } catch (e) {
        if (e instanceof SandboxNotFoundError) return { state: "lost" };
        throw e;
      }
      if (res.exitCode !== 0) throw new InfraError(`status failed (${res.exitCode})`);
      const [state, a, b, hb, why] = dec.decode(res.stdout).trim().split(" ");
      const lastHeartbeatAt = Number(hb) > 0 ? Number(hb) * 1000 : undefined;
      const hbPart = lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt };
      if (state === "running" || state === "lost") return { state, ...hbPart };
      if (state === "exited" || state === "killed") {
        const reason = why === "-" ? {} : { reason: why as ExecReason };
        return { state, exitCode: Number(a), endedAt: Number(b) * 1000, ...reason, ...hbPart };
      }
      throw new InfraError(`status: unparseable reply ${JSON.stringify(state)}`);
    },

    async logs(id, execId, opts: ExecLogsOptions): Promise<ExecLogs> {
      if (!Number.isInteger(opts.fromOffset) || opts.fromOffset < 0) {
        throw new SpecError("fromOffset must be a non-negative integer");
      }
      if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) {
        throw new SpecError("maxBytes must be a positive integer");
      }
      const res = await sh(id, LOGS_SH, [
        dirOf(execId),
        String(opts.fromOffset),
        String(opts.maxBytes),
        String(head),
        String(tail),
      ]);
      if (res.exitCode !== 0) throw new InfraError(`logs failed (${res.exitCode})`);
      const { header, body } = splitHeader(res.stdout);
      const f = header.split(" ");
      if (f[0] === "X") throw new InfraError("exec output is missing");
      const next = Number(f[1]);
      const size = Number(f[2]);
      const finished = f[3] === "1";
      if (f[0] === "C") {
        const eof = finished && next >= size;
        return { bytes: cutMarker(Number(f[4])), nextOffset: next, eof };
      }
      if (f[0] !== "R" || body.length !== next - opts.fromOffset) {
        throw new InfraError(`logs: bad reply (${header}, ${body.length} bytes)`);
      }
      return { bytes: body, nextOffset: next, eof: finished && next >= size };
    },

    async kill(id, execId, signal) {
      if (!SIGNALS.includes(signal)) throw new SpecError(`unsupported signal ${signal}`);
      try {
        const res = await sh(id, KILL_SH, [dirOf(execId), signal]);
        if (res.exitCode !== 0) throw new InfraError(`kill failed (${res.exitCode})`);
      } catch (e) {
        if (e instanceof SandboxNotFoundError) return;
        throw e;
      }
    },
  };
}
