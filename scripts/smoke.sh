#!/usr/bin/env bash
# Starts a compiled binary in an empty directory, waits for /healthz, then stops it.
# Usage: scripts/smoke.sh dist/turntable-linux-x64
set -euo pipefail
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
port="${PORT:-18080}"
work="$(mktemp -d)"
trap 'kill "${pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
cd "$work"
start=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1e9))')
"$bin" serve --port "$port" --data-dir "$work/data" >"$work/log" 2>&1 &
pid=$!
for _ in $(seq 1 100); do
  if body=$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null); then
    end=$(date +%s%N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1e9))')
    echo "healthz: $body"
    echo "cold start to healthy: $(( (end - start) / 1000000 )) ms"
    test -f "$work/data/turntable.db" || { echo "database file missing"; exit 1; }
    exit 0
  fi
  sleep 0.1
done
echo "server did not become healthy"; cat "$work/log"; exit 1
