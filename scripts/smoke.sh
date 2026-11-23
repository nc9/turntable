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
    # The embedded UI: the app shell, its CSP, an asset, and the SPA fallback for a deep route.
    headers=$(curl -fsS -D - -o "$work/index.html" "http://127.0.0.1:$port/")
    echo "$headers" | grep -iq '^content-security-policy:.*script-src .self.' || { echo "missing UI CSP on /"; echo "$headers"; exit 1; }
    echo "$headers" | grep -iq '^content-security-policy:.*frame-ancestors .none.' || { echo "CSP lacks frame-ancestors"; exit 1; }
    grep -q '<div id="root">' "$work/index.html" || { echo "/ is not the app shell"; exit 1; }
    asset=$(grep -o '/assets/[^"]*\.js' "$work/index.html" | head -1)
    test -n "$asset" || { echo "no script asset in index.html"; exit 1; }
    curl -fsS -o /dev/null "http://127.0.0.1:$port$asset" || { echo "asset $asset not served"; exit 1; }
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/acme/api/runs/x")
    test "$code" = "200" || { echo "deep route returned $code, expected the app shell"; exit 1; }
    echo "ui: shell, csp, asset and spa fallback ok"
    # The backup copy runs on a worker embedded in the binary (#310): no worker file on disk.
    "$bin" db backup --data-dir "$work/data" >"$work/backup.log" 2>&1 || { echo "db backup failed"; cat "$work/backup.log"; exit 1; }
    ls "$work"/data/backups/turntable-*.db >/dev/null || { echo "no backup file written"; exit 1; }
    echo "db backup: embedded worker ok"
    exit 0
  fi
  sleep 0.1
done
echo "server did not become healthy"; cat "$work/log"; exit 1
