# @turntable/provider-docker

Provider for the local Docker daemon, via the `docker` CLI. It is the try-out provider and the
one CI uses to run the conformance suite.

## Sandbox shape

`docker run -d --rm --init` with the container's main process set to `sleep <ttlSeconds>`. That
is the TTL backstop: when the sleep ends the container exits and `--rm` removes it, even if the
controller is gone. Every container carries `turntable.managed=1` plus the spec labels, and
list and destroy only touch managed containers. Commands run through `docker exec` with the
SDK's detached wrapper. No env is ever passed (`-e` is never emitted).

Create supports `image` only (no snapshots or templates), no disk limit, and egress `none` or
`open`. `--cpus` and `--memory` map from `resources`.

## Network

Egress `none` becomes `--network none`: no interfaces but loopback. `open` keeps the default
bridge. `allowlist` and `deny-all-except-proxy` are rejected with `SpecError`, because Docker
cannot enforce them. The conformance suite proves `none` by running an outbound probe that must
fail.

## Hardening defaults

Each is configurable via `DockerProviderOptions.hardening`:

| Option            | Default             | Flag                                        |
| ----------------- | ------------------- | ------------------------------------------- |
| `noNewPrivileges` | `true`              | `--security-opt no-new-privileges`          |
| `pidsLimit`       | `4096` (0 disables) | `--pids-limit`                              |
| `capDrop`         | `["NET_RAW"]`       | `--cap-drop`                                |
| `runtime`         | unset               | `--runtime`, for example `runsc` for gVisor |

## Argument safety

Images must match a strict reference pattern with no leading dash. Container ids and names are
validated before every CLI call, and `--` precedes positional arguments in `run`, `exec`, `rm`
and `inspect`, so a hostile value can never become a docker flag.
