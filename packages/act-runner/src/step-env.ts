// The environment a step runs in, made to match GitHub's hosted runner (parity assumptions P1 to
// P4 in the README).
//
// act v0.2.97 allocates a pseudo-terminal for EVERY host-mode command, unconditionally
// (`if true /* allocate Terminal */` in pkg/container/host_environment.go, no flag or env turns
// it off), and sets the step's stdin, stdout and stderr to it. So `[ -t 1 ]` and
// `process.stdout.isTTY` are true in a step, where on a GitHub runner they are false: a program
// that colours its output, sizes a table or handles escapes by TTY-ness behaves differently
// (squirrelscan's `fmt` colours when `process.stdout.isTTY && TERM !== "dumb"`, which broke two
// of its tests that assert no escape sequence in the output).
//
// act cannot be told not to, so the commands it launches are wrapped. act resolves a step's
// interpreter (`bash`, `sh`, `python`, `node`, `pwsh`) through the PATH it inherits, so a
// directory of shims first on that PATH sees every step. The shim runs the real interpreter with
// stdin from /dev/null and stdout and stderr on a pipe (merged, as GitHub's runner captures
// them), and forwards the pipe to act's pty. Everything the step starts inherits that pipe.

/** Interpreters act launches for steps. Each gets a symlink to the one shim. */
export const SHIM_NAMES: readonly string[] = ["bash", "sh", "python", "python3", "node", "pwsh"];

/** Constants set for act (and so every step), inside the sandbox. Never controller env. */
export const STEP_ENV: readonly string[] = [
  // act's pty would make `git log` page and block until the timeout.
  "GIT_PAGER=cat",
  "PAGER=cat",
  "GIT_TERMINAL_PROMPT=0",
  // GitHub's hosted runners and act's own container mode use this locale. The sandbox image may
  // have none (POSIX), which changes sorting, case folding and character handling.
  "LANG=C.UTF-8",
  // LC_ALL overrides every LC_* and LANG a tool or image sets, so the locale is the same everywhere.
  "LC_ALL=C.UTF-8",
];

/**
 * The launcher: puts the shim directory first on PATH, UNSETS TERM (GitHub's runner has no
 * terminal, so no TERM; `dumb` would also hide the errors tput and clear give there), sets
 * STEP_ENV, and execs act. `CI=true` and `GITHUB_ACTIONS=true` are set by act itself.
 */
export function launcherArgv(shimDir: string, actArgv: readonly string[]): string[] {
  return [
    "sh",
    "-c",
    'PATH="$1:$PATH"; shift; export PATH; exec env -u TERM "$@"',
    "tt",
    shimDir,
    ...STEP_ENV,
    ...actArgv,
  ];
}

/** Writes the shim and its symlinks. Args: shim dir, shim text, names. */
export const INSTALL_SHIMS_SH = `set -eu
d=$1; text=$2; shift 2
mkdir -p "$d"
printf '%s\\n' "$text" > "$d/step-shim"
chmod 0755 "$d/step-shim"
for n in "$@"; do ln -sf step-shim "$d/$n"; done
`;

/** The shim. POSIX sh, no bashisms: it stands in for bash and sh themselves. */
export const STEP_SHIM = `#!/bin/sh
# Longshore step shim: runs the real interpreter with no terminal on stdin, stdout or stderr, as
# on a GitHub hosted runner. See packages/act-runner/src/step-env.ts.
self=\${0##*/}
dir=$(cd "$(dirname "$0")" && pwd)
real=
oldifs=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$d" = "$dir" ] && continue
  case $(readlink "$d/$self" 2>/dev/null) in step-shim | */step-shim) continue ;; esac
  if [ -x "$d/$self" ] && [ ! -d "$d/$self" ]; then
    real="$d/$self"
    break
  fi
done
IFS=$oldifs
if [ -z "$real" ]; then
  echo "longshore: $self: command not found" >&2
  exit 127
fi
# Already inside a wrapped step: what it started inherits non-tty stdio, so just run it.
if [ -n "\${LONGSHORE_STEP_IO:-}" ]; then exec "$real" "$@"; fi
fifo=$(mktemp -u "\${TMPDIR:-/tmp}/ls-step.XXXXXX" 2>/dev/null) && mkfifo -m 600 "$fifo" 2>/dev/null || exec "$real" "$@"
cat <"$fifo" &
cpid=$!
trap 'rm -f "$fifo"' EXIT
LONGSHORE_STEP_IO=1 "$real" "$@" >"$fifo" 2>&1 </dev/null
rc=$?
# The forwarder ends at EOF. A step that leaves a background process holding the pipe must not
# hold the step: give the forwarder two seconds, then stop it.
( sleep 2; kill "$cpid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
killer=$!
wait "$cpid" 2>/dev/null
kill "$killer" 2>/dev/null
wait "$killer" 2>/dev/null
exit "$rc"
`;
