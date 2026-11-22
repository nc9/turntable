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
COPY packages/redact/package.json packages/redact/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/act-runner/package.json packages/act-runner/package.json
RUN bun install --frozen-lockfile
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
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build --chmod=0755 /turntable /turntable
COPY --from=build --chown=nonroot:nonroot /data /data
ENV TURNTABLE_HOST=0.0.0.0
USER nonroot:nonroot
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/turntable","serve","--data-dir","/data"]
