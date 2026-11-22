#!/usr/bin/env bash
# Runs the built (distroless) image and proves it works at runtime: libc fit, healthz, the UI
# and its CSP, PORT as the default port, and first-boot access via a bootstrap token hash.
# Usage: scripts/smoke-image.sh turntable:smoke
set -euo pipefail
image="$1"
port="${PORT:-18081}"
cids=()
cleanup() {
  for c in "${cids[@]:-}"; do
    [ -n "$c" ] || continue
    docker logs "$c" 2>&1 | tail -15 || true
    docker stop "$c" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

wait_healthy() { # port
  for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "server did not become healthy on $1"; return 1
}

# 1. Defaults: TURNTABLE_HOST=0.0.0.0 and a mapped port.
cid=$(docker run -d --rm -p "$port:8080" -e TURNTABLE_HOST=0.0.0.0 "$image")
cids+=("$cid")
wait_healthy "$port"
echo "healthz: $(curl -fsS "http://127.0.0.1:$port/healthz")"
headers=$(curl -fsS -D - -o /tmp/tt-index.html "http://127.0.0.1:$port/")
echo "$headers" | grep -iq '^content-security-policy:.*script-src .self.' || { echo "missing CSP on /"; echo "$headers"; exit 1; }
echo "$headers" | grep -iq '^content-security-policy:.*frame-ancestors .none.' || { echo "CSP lacks frame-ancestors"; exit 1; }
grep -q '<div id="root">' /tmp/tt-index.html || { echo "/ is not the app shell"; exit 1; }
user=$(docker inspect -f '{{.Config.User}}' "$image")
case "$user" in nonroot*|65532*) ;; *) echo "image does not run as nonroot (user: $user)"; exit 1;; esac
docker stop "$cid" >/dev/null
echo "image: healthz, ui, csp, nonroot ok"

# 2. PORT is the default for --port, and a bootstrap token hash gives first-boot access.
token="tt_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
cid=$(docker run -d --rm -p "$port:9090" -e PORT=9090 -e TURNTABLE_HOST=0.0.0.0 \
  -e TURNTABLE_BOOTSTRAP_TOKEN_SHA256="$hash" "$image")
cids+=("$cid")
wait_healthy "$port"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/runs")
test "$code" = "401" || { echo "unauthenticated API returned $code, expected 401"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$port/api/v1/runs")
test "$code" = "200" || { echo "bootstrap token returned $code, expected 200"; exit 1; }
if docker logs "$cid" 2>&1 | grep -qF "$token"; then echo "token leaked into the logs"; exit 1; fi
echo "image: PORT and bootstrap token ok"
