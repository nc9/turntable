/**
 * Sandbox-side exec wrapper (POSIX sh). Providers never upload it separately: `start` passes it as
 * an argument to a launcher, so a start is one atomic short command.
 *
 * Files in the exec dir `<base>/<id>`:
 *   created    epoch seconds, written by the launcher
 *   cmd.sh     `cd <cwd>; exec <argv>`, shell-quoted by the SDK
 *   run.sh     this wrapper
 *   pid        wrapper pid (atomic write)
 *   cpid       command pid, also its process group id (the command runs in its own group)
 *   hb         epoch seconds, refreshed every tick*hbEvery seconds
 *   out        combined stdout and stderr while running (and after, when small)
 *   head/tail/capped  after exit, only when out exceeded head+tail+slack: first HEAD bytes, last
 *              TAIL bytes, and the original size. `out` is removed after these are complete.
 *   killed/timedout/outlimit  markers, why the command was signalled. A non-zero exit with a marker
 *              is state `killed` (a process may handle TERM and exit 1, not 143)
 *   exit       "<code> <epoch seconds>", written LAST via tmp + mv. Its existence means every
 *              other file is final.
 *
 * Why the command gets its own process group: a group SIGKILL must not kill the wrapper, or the
 * exit code would never be written. `setsid` is used when present; otherwise `set -m` (job
 * control makes a background job a group leader). If neither isolates, kill falls back to the
 * bare pid.
 *
 * Disk bound: the at-exit cap bounds retained output to head+tail+slack. While running, a
 * watchdog in the wrapper kills the command (SIGKILL, marker `outlimit`) once `out` exceeds the
 * hard ceiling, so in-sandbox disk use is bounded by roughly that ceiling.
 *
 * No `$` followed by a brace appears below: this is a plain template string, not interpolation.
 */

export const WRAPPER_VERSION = 1;

/** run.sh. Args: dir timeoutSeconds hardLimitBytes head tail slack tickSeconds hbEveryTicks */
export const WRAPPER_SH = String.raw`#!/bin/sh
D=$1; T=$2; LIMIT=$3; HEAD=$4; TAIL=$5; SLACK=$6; TICK=$7; HBN=$8
trap '' HUP
RP=$$
wr() { printf '%s\n' "$2" > "$D/$1.tmp" && mv -f "$D/$1.tmp" "$D/$1"; }
sigall() { kill -s "$1" -- "-$CP" 2>/dev/null || kill -s "$1" "$CP" 2>/dev/null; }
wr pid "$RP"
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$D/cmd.sh" >"$D/out" 2>&1 </dev/null &
else
  set -m 2>/dev/null
  sh "$D/cmd.sh" >"$D/out" 2>&1 </dev/null &
  set +m 2>/dev/null
fi
CP=$!
wr cpid "$CP"
(
  i=0
  while kill -0 "$RP" 2>/dev/null; do
    if [ $((i % HBN)) -eq 0 ]; then wr hb "$(date +%s)"; fi
    sz=$(( $(wc -c < "$D/out" 2>/dev/null || echo 0) ))
    if [ "$sz" -gt "$LIMIT" ]; then
      : > "$D/outlimit"
      sigall KILL
    fi
    i=$((i + 1))
    sleep "$TICK"
  done
) </dev/null >/dev/null 2>&1 &
HB=$!
TW=
if [ "$T" -gt 0 ] 2>/dev/null; then
  # The timeout watcher is its own process (group), started the way the command is, so that the
  # end of the exec can take it AND its sleep down with one group KILL. A subshell with a TERM trap
  # raced: a TERM landing between starting the sleep and recording its pid left the sleep behind
  # for the whole timeout, on every exec that finished fast.
  WATCH='D=$1; T=$2; CP=$3
sigall() { kill -s "$1" -- "-$CP" 2>/dev/null || kill -s "$1" "$CP" 2>/dev/null; }
sleep "$T"
: > "$D/timedout"
sigall TERM
sleep 5
sigall KILL'
  if command -v setsid >/dev/null 2>&1; then
    setsid sh -c "$WATCH" tw "$D" "$T" "$CP" </dev/null >/dev/null 2>&1 &
  else
    set -m 2>/dev/null
    sh -c "$WATCH" tw "$D" "$T" "$CP" </dev/null >/dev/null 2>&1 &
    set +m 2>/dev/null
  fi
  TW=$!
fi
wait "$CP"
rc=$?
[ -n "$TW" ] && { kill -s KILL -- "-$TW" 2>/dev/null || kill -s KILL "$TW" 2>/dev/null; }
kill "$HB" 2>/dev/null
kill -s KILL -- "-$CP" 2>/dev/null
sz=$(( $(wc -c < "$D/out") ))
if [ "$sz" -gt $((HEAD + TAIL + SLACK)) ]; then
  head -c "$HEAD" "$D/out" > "$D/head.tmp" && mv -f "$D/head.tmp" "$D/head" &&
  tail -c "$TAIL" "$D/out" > "$D/tail.tmp" && mv -f "$D/tail.tmp" "$D/tail" &&
  wr capped "$sz" && rm -f "$D/out"
fi
wr exit "$rc $(date +%s)"
`;

/** Launcher, run as `sh -c LAUNCH_SH tt dir cmdBody runBody timeout limit head tail slack tick hbN`. */
export const LAUNCH_SH = String.raw`set -e
D=$1; C=$2; R=$3
shift 3
umask 077
mkdir -p "$(dirname "$D")"
# Atomic, and a no-op the second time: a launch that is repeated (the first reply was lost) never
# starts a second process for the same exec id.
mkdir "$D" 2>/dev/null || { [ -d "$D" ] && exit 0; exit 1; }
: > "$D/out"
printf '%s\n' "$C" > "$D/cmd.sh"
printf '%s\n' "$R" > "$D/run.sh"
date +%s > "$D/created"
if command -v setsid >/dev/null 2>&1; then
  setsid sh "$D/run.sh" "$D" "$@" </dev/null >/dev/null 2>&1 &
else
  sh "$D/run.sh" "$D" "$@" </dev/null >/dev/null 2>&1 &
fi
`;

/** Status. Args: dir. Prints "<state> <code> <endedAt> <hb> <reason>". */
export const STATUS_SH = String.raw`D=$1
hb=0
[ -f "$D/hb" ] && read hb < "$D/hb"
report() {
  [ -f "$D/exit" ] || return 1
  read rc ts < "$D/exit"
  st=exited; why=-
  if [ "$rc" -ne 0 ]; then
    if [ -f "$D/outlimit" ]; then st=killed; why=output_limit
    elif [ -f "$D/timedout" ]; then st=killed; why=timeout
    elif [ -f "$D/killed" ]; then st=killed; why=killed
    fi
  fi
  echo "$st $rc $ts $hb $why"
}
report && exit 0
if [ -f "$D/pid" ]; then
  read p < "$D/pid"
  if kill -0 "$p" 2>/dev/null; then echo "running 0 0 $hb -"; exit 0; fi
  report && exit 0
  echo "lost 0 0 $hb -"; exit 0
fi
if [ -f "$D/created" ]; then
  read c < "$D/created"
  if [ $(( $(date +%s) - c )) -lt 30 ]; then echo "running 0 0 $hb -"; exit 0; fi
fi
echo "lost 0 0 $hb -"
`;

/** Kill. Args: dir signal. Always exits 0. */
export const KILL_SH = String.raw`D=$1; S=$2
[ -f "$D/exit" ] && exit 0
[ -d "$D" ] || exit 0
: > "$D/killed"
i=0
while [ ! -f "$D/cpid" ] && [ "$i" -lt 3 ]; do sleep 1; i=$((i + 1)); done
[ -f "$D/cpid" ] || exit 0
read c < "$D/cpid"
kill -s "$S" -- "-$c" 2>/dev/null || kill -s "$S" "$c" 2>/dev/null
exit 0
`;

/**
 * Logs. Args: dir offset maxBytes head tail. Output is one header line then raw bytes.
 *   R <next> <size> <finished>   data bytes follow
 *   C <next> <size> <finished> <omitted>   the cut: no data, next jumps over the omitted bytes
 *   X   no output files at all
 * "finished" is read BEFORE size, so finished=1 means the sizes are final.
 */
export const LOGS_SH = String.raw`D=$1; off=$2; max=$3; HEAD=$4; TAIL=$5
fin=0
[ -f "$D/exit" ] && fin=1
raw() {
  exec 3<"$D/out" || exit 9
  exec 4<"$D/out" || exit 9
  size=$(( $(wc -c <&3) ))
  n=$((size - off)); [ "$n" -gt "$max" ] && n=$max; [ "$n" -lt 0 ] && n=0
  printf 'R %s %s %s\n' $((off + n)) "$size" "$fin"
  [ "$n" -gt 0 ] && tail -c +$((off + 1)) <&4 | head -c "$n"
  exit 0
}
(raw) 2>/dev/null
rc=$?
[ "$rc" -eq 0 ] && exit 0
if [ ! -f "$D/capped" ]; then echo X; exit 0; fi
read S < "$D/capped"
ts=$((S - TAIL))
if [ "$off" -lt "$HEAD" ]; then
  n=$((HEAD - off)); [ "$n" -gt "$max" ] && n=$max
  printf 'R %s %s %s\n' $((off + n)) "$S" "$fin"
  [ "$n" -gt 0 ] && tail -c +$((off + 1)) "$D/head" | head -c "$n"
elif [ "$off" -lt "$ts" ]; then
  printf 'C %s %s %s %s\n' "$ts" "$S" "$fin" $((ts - HEAD))
elif [ "$off" -lt "$S" ]; then
  n=$((S - off)); [ "$n" -gt "$max" ] && n=$max
  printf 'R %s %s %s\n' $((off + n)) "$S" "$fin"
  [ "$n" -gt 0 ] && tail -c +$((off - ts + 1)) "$D/tail" | head -c "$n"
else
  printf 'R %s %s %s\n' "$off" "$S" "$fin"
fi
exit 0
`;
