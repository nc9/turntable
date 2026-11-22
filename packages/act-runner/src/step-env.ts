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

/**
 * The shim. POSIX sh, no bashisms: it stands in for bash and sh themselves.
 *
 * It stays as the step's parent so every byte is forwarded before act moves on. That makes it the
 * process act's step-timeout SIGKILL hits, so it also guards the interpreter's life:
 *  - the interpreter runs in its OWN process group (perl setpgrp, then exec: perl is in Debian's
 *    base set), with the signal dispositions the shell's `&` would have ignored put back;
 *  - TERM, INT and HUP sent to the shim go to that group, and KILL follows after a grace period
 *    (LONGSHORE_STEP_GRACE seconds, default 5);
 *  - SIGKILL of the shim cannot be trapped, so a tiny watcher polls the shim: when the shim is gone
 *    while the interpreter still runs, the group gets TERM and then KILL. When the interpreter
 *    ended normally (and left a daemon behind on purpose) the watcher does nothing.
 * Without perl the interpreter simply runs in the shim's own group, with no watchdog.
 */
export const STEP_SHIM = `#!/bin/sh
# Longshore step shim: runs the real interpreter with no terminal on stdin, stdout or stderr, as
# on a GitHub hosted runner, and keeps it from outliving a killed step. See
# packages/act-runner/src/step-env.ts.
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
shim=$$
grace=\${LONGSHORE_STEP_GRACE:-5}
if command -v perl >/dev/null 2>&1; then
  # Own process group; and undo what the shell does to an async command (ignore INT and QUIT).
  LONGSHORE_STEP_IO=1 perl -e '$SIG{INT}="DEFAULT"; $SIG{QUIT}="DEFAULT"; setpgrp(0,0); exec @ARGV or exit 127' "$real" "$@" >"$fifo" 2>&1 </dev/null &
  rpid=$!
  # Signal the interpreter's whole group through perl: the shell kill builtin with a negative pid is not portable across the
  # shells that stand in for sh (dash, the Linux default, failed it). Bare pid if the group is not
  # made yet.
  gkill() {
    perl -e 'kill($ARGV[0], -$ARGV[1]) or exit 1' "$1" "$2" 2>/dev/null || kill "-$1" "$2" 2>/dev/null
  }
  stop() {
    stopped=1
    gkill TERM "$rpid"
    ( sleep "$grace"; gkill KILL "$rpid" ) >/dev/null 2>&1 </dev/null &
  }
  trap stop TERM INT HUP
  # The watcher: if this shim dies without a chance to clean up (SIGKILL), and the interpreter is
  # still running, take its group down. A normal end leaves the interpreter gone and this idle.
  (
    while kill -0 "$shim" 2>/dev/null; do sleep 1; done
    if kill -0 "$rpid" 2>/dev/null; then
      gkill TERM "$rpid"
      sleep "$grace"
      gkill KILL "$rpid"
    fi
  ) >/dev/null 2>&1 </dev/null &
  wait "$rpid"
  rc=$?
  # A trapped signal interrupts wait while the interpreter is still going: wait for the real end.
  # (stop runs first and takes a moment, so the interpreter may already be gone: wait again anyway.)
  while kill -0 "$rpid" 2>/dev/null || [ -n "$stopped" ]; do
    stopped=
    wait "$rpid"
    r=$?
    if [ "$r" -ne 127 ]; then rc=$r; fi
  done
else
  LONGSHORE_STEP_IO=1 "$real" "$@" >"$fifo" 2>&1 </dev/null
  rc=$?
fi
# The forwarder ends at EOF. A step that leaves a background process holding the pipe must not
# hold the step: give the forwarder two seconds, then stop it.
( sleep 2; kill "$cpid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
killer=$!
wait "$cpid" 2>/dev/null
kill "$killer" 2>/dev/null
wait "$killer" 2>/dev/null
exit "$rc"
`;
