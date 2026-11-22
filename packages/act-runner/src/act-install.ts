import { InfraError } from "@turntable/provider-sdk";

/** nektos/act (MIT). Bump version and both hashes together, from the release's checksums.txt. */
export const ACT_VERSION = "v0.2.97";
export const ACT_RELEASES = {
  amd64: {
    asset: "act_Linux_x86_64.tar.gz",
    sha256: "67b4976a56f33ea7870b798912e738ec44eef38e7578ae7b532f2def1c73a5ad",
  },
  arm64: {
    asset: "act_Linux_arm64.tar.gz",
    sha256: "44d48e3d4a6409053fdec6fc6518322467d79a2d5be8f72c021b0421e2ac113d",
  },
} as const;

export type ActArch = keyof typeof ACT_RELEASES;

export interface ActTarball {
  bytes: Uint8Array;
  sha256: string;
}

export function archFromUname(machine: string): ActArch | undefined {
  const m = machine.trim();
  if (m === "x86_64" || m === "amd64") return "amd64";
  if (m === "aarch64" || m === "arm64") return "arm64";
  return undefined;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const cache = new Map<ActArch, Uint8Array>();

/** Downloads the pinned act release and verifies it against the committed sha256. */
export async function fetchAct(arch: ActArch): Promise<ActTarball> {
  const rel = ACT_RELEASES[arch];
  const hit = cache.get(arch);
  if (hit) return { bytes: hit, sha256: rel.sha256 };
  const url = `https://github.com/nektos/act/releases/download/${ACT_VERSION}/${rel.asset}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new InfraError(`cannot download ${url}`, e);
  }
  if (!res.ok) throw new InfraError(`download ${url} failed: HTTP ${res.status}`);
  const bytes = await res.bytes();
  const got = sha256Hex(bytes);
  if (got !== rel.sha256) {
    throw new InfraError(`act checksum mismatch for ${rel.asset}: got ${got}, want ${rel.sha256}`);
  }
  cache.set(arch, bytes);
  return { bytes, sha256: rel.sha256 };
}

/** Sandbox script. Args: tarball sha256 root. Verifies again inside the sandbox, then unpacks. */
export const INSTALL_SH = `set -eu
f=$1; want=$2; root=$3
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$f" | cut -d' ' -f1)
else got=$(shasum -a 256 "$f" | cut -d' ' -f1); fi
[ "$got" = "$want" ] || { echo "act checksum mismatch: $got" >&2; exit 3; }
tar xzf "$f" -C "$root" act
chmod 0755 "$root/act"
mkdir -p "$root/repo"
tar xzf "$root/repo.tgz" --no-same-owner -C "$root/repo"
`;

/** Fetches the source tarball of an action at an exact commit sha (never a tag or branch). */
export type ActionFetcher = (repo: string, sha: string) => Promise<Uint8Array>;

export const fetchActionTarball: ActionFetcher = async (repo, sha) => {
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new InfraError(`refusing to fetch ${repo} by non-sha ${sha}`);
  const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new InfraError(`cannot download ${url}`, e);
  }
  if (!res.ok) throw new InfraError(`download ${url} failed: HTTP ${res.status}`);
  return res.bytes();
};

/** Sandbox script. Args: tarball dir. Unpacks a GitHub source tarball (one top dir) into dir. */
export const EXTRACT_ACTION_SH = `set -eu
mkdir -p "$2"
tar xzf "$1" --strip-components=1 --no-same-owner -C "$2"
`;
