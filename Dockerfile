# syntax=docker/dockerfile:1
# Base images are pinned by exact tag and digest. Bump both together.

# oven/bun 1.4.5 (multi-arch index digest)
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
ARG TARGETARCH
ARG TURNTABLE_VERSION=0.0.0-docker
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
# `COPY . .` carries a BUILD_SHA file (the commit CD deploys) when the build context has one;
# scripts/build.ts stamps it into the binary and /healthz reports it as build_sha, else "unknown".
COPY . .
RUN case "${TARGETARCH}" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && TURNTABLE_VERSION="${TURNTABLE_VERSION}" bun run scripts/build.ts "${target}" \
    && mv "dist/turntable-${target#bun-}" /turntable \
    && mkdir /data

# distroless cc-debian12 nonroot (multi-arch index digest). The compiled binary is a
# dynamically linked glibc executable; this image ships glibc, libgcc and libstdc++, and no shell.
# The control plane runs no other program: a run's commit is fetched and packed in process (git's
# smart-HTTP protocol and a tar writer inside the binary), so the image needs no git and no tar.
# `scripts/smoke-image.sh` proves it with a real checkout (`turntable fetch-source`).
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build --chmod=0755 /turntable /turntable
COPY --from=build --chown=nonroot:nonroot /data /data
ENV TURNTABLE_HOST=0.0.0.0
# Starts as root only so it can take ownership of a volume a platform mounted as root (Railway),
# then drops to nonroot (65532) before it opens anything: the server refuses to keep running as
# root. Run with `--user 65532:65532` and no drop happens (nothing to do).
ENV TURNTABLE_DROP_PRIVILEGES=65532:65532
USER 0:0
# Data lives in /data. Mount a volume there (docker run -v ..., or your platform's volume feature).
# No VOLUME directive: some platforms (Railway) reject it, and an anonymous volume hides data loss.
EXPOSE 8080
ENTRYPOINT ["/turntable","serve","--data-dir","/data"]
