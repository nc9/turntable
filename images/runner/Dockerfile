# The Turntable runner image: the sandbox a job's steps run in. It is the pinned node image (bash,
# git, curl, node, python3, build tools) plus the few GitHub ubuntu-latest tools workflows commonly
# assume and the base lacks. Every download is pinned by version and checked against a checksum.
# docs/compatibility.mdx lists what is and is not in it, generated from the built image in CI.
ARG BASE=node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
FROM ${BASE}

ARG TARGETARCH
# PowerShell 7.4 LTS. Checksums are from the release's hashes.sha256.
ARG PWSH_VERSION=7.4.6
ARG PWSH_SHA256_AMD64=6f6015203c47806c5cc444c19d8ed019695e610fbd948154264bf9ca8e157561
ARG PWSH_SHA256_ARM64=c0159b03e85f44ae1e7697818a011558da6c813d0aae848bf5ac13bf435d8624

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends jq rsync zip unzip sudo libicu72; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="${PWSH_SHA256_AMD64}" ;; \
      arm64) arch=arm64; sum="${PWSH_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/pwsh.tar.gz \
      "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${arch}.tar.gz"; \
    echo "${sum}  /tmp/pwsh.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/microsoft/powershell/7; \
    tar -xzf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell/7; \
    chmod +x /opt/microsoft/powershell/7/pwsh; \
    ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh; \
    rm /tmp/pwsh.tar.gz; \
    pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
