# @turntable/provider-sdk

The contract between Turntable and sandbox providers (Docker, Daytona and others).

## Rule zero

No method may require a long-lived stream for correctness. A silent log stream can be dropped by
a network path after a few minutes while the job finishes unnoticed. So the authoritative
operations are:

- `exec.start` launches detached and returns an `execId` at once.
- `exec.status` polls state and exit code.
- `exec.logs(fromOffset, maxBytes)` reads output by logical byte offset.

Streaming may be added as an optimisation, never as the only way to learn a result.

## Contract summary

- `SandboxSpec` has no `env` field. Environment never passes through a provider.
- `destroy` is idempotent; a missing sandbox is success. `destroyByLabels` refuses empty labels.
- `files.put` and `files.get` refuse past their caps with `FileTooLargeError`.
- Errors: `InfraError` is retryable, `SpecError` is not (`SandboxNotFoundError` and
  `FileTooLargeError` are `SpecError`s).
- No in-memory state: any provider instance, including one built after a controller restart, can
  answer `status` and `logs` for an `execId` it never saw.

## Implementing exec

Supply one primitive, a `ShellRunner` that runs a short command and returns its output, then call
`createWrappedExec(runner)`. The sandbox needs a POSIX `sh`, `head`, `tail`, `wc`, `date`, `sleep`
and `mv` (any busybox or coreutils image has them).

`start` passes the wrapper script and the quoted command as positional arguments to one launcher
command, so a start is atomic and uploads nothing.

### The wrapper

State lives in `/tmp/.turntable/<execId>` inside the sandbox:

| File                             | Meaning                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `out`                            | Combined stdout and stderr while running                                                                        |
| `exit`                           | `<code> <epoch>`, written last via tmp and `mv`, so it is atomic. Its existence means every other file is final |
| `pid`, `cpid`                    | Wrapper pid, and command pid which is also its process group id                                                 |
| `hb`                             | Heartbeat, refreshed about every 30 s                                                                           |
| `killed`, `timedout`, `outlimit` | Why the command was signalled                                                                                   |
| `head`, `tail`, `capped`         | Output retained after exit when it was too large                                                                |

The command runs in its own process group (`setsid`, else `set -m`) so a group SIGKILL cannot
take the wrapper with it and the exit code is always written. If neither isolates, kill falls
back to the bare pid.

`status` checks `exit`, then wrapper liveness, then `exit` again before answering `lost`, which
closes the race with a wrapper that exits between the two checks. `lost` also covers a wiped
sandbox or a dead wrapper.

### Execution id

`tt1-<24 hex>`. `tt1` is the wrapper layout version and the dir is `<base>/<execId>` with a base
fixed per provider, so the id alone locates everything. Ids are regex-validated before they
touch a path.

### Output cap

After exit, output larger than head (1 MiB) + tail (4 MiB) + slack (64 KiB) is cut: the wrapper
saves the first 1 MiB and last 4 MiB plus the original size, then deletes `out`. `exec.logs`
keeps offsets logical. A read that lands in the cut returns a marker line
(`[turntable: N bytes of output omitted]`) and jumps `nextOffset` past it, so a reader polling
across the exit sees no lost or duplicated real bytes. Reading raw `out` opens it before
checking, so an exit-time cap cannot pull the file out from under a read.

`capOutput` applies the same cut to bytes already accumulated by a reader (head + marker + tail),
for the core reader that may have read more than the sandbox retained.

While the command runs, the wrapper kills it (SIGKILL, state `killed`) once `out` exceeds a hard
ceiling (default 1 GiB), checked every tick (5 s). In-sandbox disk use is therefore bounded by
roughly that ceiling plus what is written in one tick.

### Status reason

A `killed` status carries `reason`: `timeout` (the `timeoutSeconds` limit), `killed` (an
`exec.kill` call) or `output_limit` (the output ceiling), derived from the marker files.

## Trust

The exec dir lives inside the sandbox and is writable by the job's own code. A job can therefore
forge its own exit code or kill the wrapper. That only lets it lie about itself, which its own
code could already do. A killed wrapper shows up as `lost`, which the core treats as an infra
error. Never use one job's self-reported result as a security gate for another trust class.

## Testing

`@turntable/provider-sdk/testing` exports `FakeWorld`, which backs providers with temp dirs and
real local `sh` processes under a scrubbed environment, with scriptable failures (`failNext`,
`dropConnections`, `loseExec`, `setLatency`). Run any provider through
`@turntable/provider-conformance`.
