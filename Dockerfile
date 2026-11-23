# syntax=docker/dockerfile:1
# Base images are pinned by exact tag and digest. Bump both together.

# oven/bun 1.4.5 (multi-arch index digest)
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
ARG TARGETARCH
ARG LONGSHORE_VERSION=0.0.0-docker
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/provider-sdk/package.json packages/provider-sdk/package.json
COPY packages/provider-conformance/package.json packages/provider-conformance/package.json
COPY packages/provider-docker/package.json packages/provider-docker/package.json
COPY packages/provider-daytona/package.json packages/provider-daytona/package.json
COPY packages/redact/package.json packages/redact/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/act-runner/package.json packages/act-runner/package.json
COPY packages/net/package.json packages/net/package.json
COPY packages/proxy/package.json packages/proxy/package.json
COPY packages/signer/package.json packages/signer/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN case "${TARGETARCH}" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && LONGSHORE_VERSION="${LONGSHORE_VERSION}" bun run scripts/build.ts "${target}" \
    && mv "dist/longshore-${target#bun-}" /longshore \
    && mkdir /data

# debian 12 slim (multi-arch index digest) with git and tar. The control plane runs `git` to fetch a
# run's commit and `tar` to pack it (scheduler/act-runner.ts, run/repo-archive.ts), so a shell-less
# distroless image cannot run jobs: copying git and its ~30 shared libraries (curl with gnutls, krb5,
# ldap and the rest, plus the certificate store) out of a build stage is more fragile than this
# base. The compiled binary is a dynamically linked glibc executable; this image ships glibc,
# libgcc and libstdc++. Packages come from Debian's repositories over the signed apt index; the
# base image is pinned by digest. `scripts/smoke-image.sh` runs git over https as uid 65532.
FROM debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65532 nonroot \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nonroot
COPY --from=build --chmod=0755 /longshore /longshore
COPY --from=build --chown=nonroot:nonroot /data /data
ENV LONGSHORE_HOST=0.0.0.0
# Starts as root only so it can take ownership of a volume a platform mounted as root (Railway),
# then drops to nonroot (65532) before it opens anything: the server refuses to keep running as
# root. Run with `--user 65532:65532` and no drop happens (nothing to do).
ENV LONGSHORE_DROP_PRIVILEGES=65532:65532
USER 0:0
# Data lives in /data. Mount a volume there (docker run -v ..., or your platform's volume feature).
# No VOLUME directive: some platforms (Railway) reject it, and an anonymous volume hides data loss.
EXPOSE 8080
ENTRYPOINT ["/longshore","serve","--data-dir","/data"]
