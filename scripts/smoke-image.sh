#!/usr/bin/env bash
# Runs the built (distroless) image and proves it works at runtime: libc fit, healthz, the UI
# and its CSP, PORT as the default port, and first-boot access via a bootstrap token hash.
# Usage: scripts/smoke-image.sh longshore:smoke
set -euo pipefail
image="$1"
cids=()
cleanup() {
  for c in "${cids[@]:-}"; do
    [ -n "$c" ] || continue
    docker logs "$c" 2>&1 | tail -15 || true
    remove_container "$c"
  done
}
trap cleanup EXIT

# Removes a container and waits until it is really gone, so nothing started next can collide with
# it (a stopped container with --rm is removed asynchronously).
remove_container() { # container id
  docker rm -f "$1" >/dev/null 2>&1 || true
  for _ in $(seq 1 100); do
    docker inspect "$1" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  echo "container $1 did not go away"; return 1
}

# Starts a container with its own random host port on loopback (never a fixed port two
# containers could fight over). Sets cid and port. Usage: start_container <internal port> <docker run args...>
start_container() {
  local internal="$1"; shift
  cid=$(docker run -d -p "127.0.0.1::$internal" "$@")
  cids+=("$cid")
  port=$(docker port "$cid" "$internal/tcp" | head -1 | sed 's/.*://')
  test -n "$port" || { echo "no host port for $cid"; exit 1; }
}

wait_healthy() { # port
  for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:$1/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "server did not become healthy on $1"; return 1
}

# 1. Defaults: LONGSHORE_HOST=0.0.0.0 and a mapped port.
start_container 8080 -e LONGSHORE_HOST=0.0.0.0 "$image"
wait_healthy "$port"
echo "healthz: $(curl -fsS "http://127.0.0.1:$port/healthz")"
headers=$(curl -fsS -D - -o /tmp/tt-index.html "http://127.0.0.1:$port/")
echo "$headers" | grep -iq '^content-security-policy:.*script-src .self.' || { echo "missing CSP on /"; echo "$headers"; exit 1; }
echo "$headers" | grep -iq '^content-security-policy:.*frame-ancestors .none.' || { echo "CSP lacks frame-ancestors"; exit 1; }
grep -q '<div id="root">' /tmp/tt-index.html || { echo "/ is not the app shell"; exit 1; }
# healthz names the version; an embedded asset the shell references is served, not just the shell.
curl -fsS "http://127.0.0.1:$port/healthz" | grep -Eq '"ok":true' || { echo "healthz is not ok"; exit 1; }
curl -fsS "http://127.0.0.1:$port/healthz" | grep -Eq '"version":"[^"]+"' || { echo "healthz has no version"; exit 1; }
asset=$(grep -Eo '(src|href)="/[^"]+\.(js|css)"' /tmp/tt-index.html | head -1 | sed -E 's/^[a-z]+="//; s/"$//')
test -n "$asset" || { echo "the app shell references no embedded asset"; exit 1; }
curl -fsS -o /tmp/tt-asset -w '%{http_code} %{content_type} %{size_download}\n' "http://127.0.0.1:$port$asset" | tee /tmp/tt-asset-info
awk '$1==200 && $3>0 {ok=1} END{exit !ok}' /tmp/tt-asset-info || { echo "embedded asset $asset not served"; exit 1; }
# The binary runs in the distroless image with no shell: `version` proves exec and libc.
docker run --rm --entrypoint /longshore "$image" version || { echo "version command failed"; exit 1; }
# The image starts as root so it can own a root-owned volume, and drops before opening anything:
# the running server must be uid 65532, real, effective and saved (so root cannot be regained).
assert_uid() { # container id, expected uid
  local pid ids
  pid=$(docker inspect -f '{{.State.Pid}}' "$1")
  ids=$(awk '/^Uid:/{print $2, $3, $4}' "/proc/$pid/status")
  test "$ids" = "$2 $2 $2" || { echo "server uids are '$ids', expected $2 $2 $2"; exit 1; }
}
assert_uid "$cid" 65532
remove_container "$cid"
echo "image: healthz, ui, csp, drops to 65532 ok"

# 2. PORT is the default for --port, and a bootstrap token hash gives first-boot access.
token="ls_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
start_container 9090 -e PORT=9090 -e LONGSHORE_HOST=0.0.0.0 \
  -e LONGSHORE_BOOTSTRAP_TOKEN_SHA256="$hash" "$image"
wait_healthy "$port"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/runs")
test "$code" = "401" || { echo "unauthenticated API returned $code, expected 401"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://127.0.0.1:$port/api/v1/runs")
test "$code" = "200" || { echo "bootstrap token returned $code, expected 200"; exit 1; }
if docker logs "$cid" 2>&1 | grep -qF "$token"; then echo "token leaked into the logs"; exit 1; fi
remove_container "$cid"
echo "image: PORT and bootstrap token ok"

# 3. A root-owned mounted volume (what Railway gives): the server chowns it, drops, and writes.
if sudo -n true 2>/dev/null; then
  vol=$(mktemp -d)
  sudo chown root:root "$vol"
  sudo chmod 0755 "$vol"
  start_container 8080 -e LONGSHORE_HOST=0.0.0.0 -v "$vol:/data" "$image"
  wait_healthy "$port"
  assert_uid "$cid" 65532
  owner=$(sudo stat -c '%u' "$vol/longshore.db")
  test "$owner" = "65532" || { echo "database is owned by $owner, expected 65532"; exit 1; }
  test "$(sudo stat -c '%u' "$vol")" = "65532" || { echo "data dir was not chowned"; exit 1; }
  remove_container "$cid"
  sudo rm -rf "$vol"
  echo "image: root-owned volume ok"
else
  echo "image: skipping the root-owned volume case (no passwordless sudo)"
fi

# 4. No drop spec means a root server is refused, unless explicitly allowed.
out=$(docker run --rm -e LONGSHORE_DROP_PRIVILEGES= "$image" 2>&1) && { echo "root server started without being allowed"; exit 1; }
echo "$out" | grep -q "refusing to run as root" || { echo "unexpected refusal output: $out"; exit 1; }
start_container 8080 -e LONGSHORE_HOST=0.0.0.0 -e LONGSHORE_DROP_PRIVILEGES= -e LONGSHORE_ALLOW_ROOT=1 "$image"
wait_healthy "$port"
assert_uid "$cid" 0
remove_container "$cid"
echo "image: root refused unless allowed ok"
