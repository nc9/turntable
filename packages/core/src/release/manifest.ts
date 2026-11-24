// The release manifest digest: ONE canonical digest of the artifact set a release lane signs.
// The approval a human signs (`turntable.approve_release.v2`) names this digest, and the signing
// service recomputes it from its own stored rows before it signs, so the bytes approved and the
// bytes signed cannot drift apart. Nothing else computes it.
//
// Encoding (stable; changing it needs a new domain line):
//
//   turntable.release_manifest.v1\n
//   <sha256 hex> <size> <name>\n      one line per artifact, sorted by name (code-unit order)
//
// sha256 is 64 lower-case hex digits, size is a non-negative decimal integer, name is the
// artifact's recorded name (no whitespace or control characters, which is what makes a line
// unambiguous). The digest is sha256 over that text as UTF-8, lower-case hex. It does not depend
// on the order the artifacts are given in. Duplicate names are refused.
import { createHash } from "node:crypto";

export const MANIFEST_DOMAIN = "turntable.release_manifest.v1";

export type ManifestArtifact = { name: string; sha256: string; size: number };

export class ManifestError extends Error {}

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[^\s\p{Cc}]{1,200}$/u;

/** The canonical manifest text, before hashing. Throws ManifestError on a malformed artifact. */
export function manifestText(artifacts: readonly ManifestArtifact[]): string {
  if (artifacts.length === 0) throw new ManifestError("a release manifest needs an artifact");
  const seen = new Set<string>();
  for (const a of artifacts) {
    if (!NAME.test(a.name)) throw new ManifestError("an artifact name is not canonical");
    if (!SHA256.test(a.sha256))
      throw new ManifestError(`the digest of ${a.name} is not sha256 hex`);
    if (!Number.isSafeInteger(a.size) || a.size < 0)
      throw new ManifestError(`the size of ${a.name} is not a non-negative integer`);
    if (seen.has(a.name)) throw new ManifestError(`${a.name} appears twice`);
    seen.add(a.name);
  }
  const lines = [...artifacts]
    .toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .map((a) => `${a.sha256} ${a.size} ${a.name}\n`);
  return `${MANIFEST_DOMAIN}\n${lines.join("")}`;
}

/** `manifest_sha256`: sha256 hex of the canonical manifest text. */
export const manifestSha256 = (artifacts: readonly ManifestArtifact[]): string =>
  createHash("sha256").update(manifestText(artifacts), "utf8").digest("hex");
