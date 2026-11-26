// The npm dist-tag of a publish: a static `tag`, or with `tag: "auto"` the release channel read
// from the version being published. Pure, so the strict publish and the compat proxy rules agree.
import { DIST_TAG } from "./types";

/** The `tag` value that derives the dist-tag from the version. */
export const AUTO_DIST_TAG = "auto";

/** The first identifier of a prerelease: lowercase, starts with a letter, never a version-like number. */
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/;
/** Tags that name no channel: `latest` is the stable channel only, never a prerelease's. */
const RESERVED = new Set(["latest"]);

export type DistTagResult = { ok: true; tag: string } | { ok: false; detail: string };

/**
 * The dist-tag to publish `version` under. A static tag is returned as declared. With `auto` a
 * plain version gets `latest`, and a prerelease (`1.2.3-beta.4`) the first part of its prerelease
 * identifier (`beta`). A prerelease whose channel is not a safe lowercase name, or is reserved,
 * is refused, so under `auto` a prerelease can never land on `latest`.
 */
export function resolveDistTag(declared: string, version: string): DistTagResult {
  if (declared !== AUTO_DIST_TAG) return { ok: true, tag: declared };
  const m = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/.exec(version);
  if (!m) return { ok: false, detail: `${version} is not a semantic version` };
  if (m[1] === undefined) return { ok: true, tag: "latest" };
  const channel = m[1].split(".")[0]!;
  if (!CHANNEL.test(channel) || !DIST_TAG.test(channel))
    return {
      ok: false,
      detail: `the prerelease channel "${channel}" is not a lowercase dist-tag (a letter, then letters, digits or -)`,
    };
  if (RESERVED.has(channel))
    return { ok: false, detail: `the prerelease channel "${channel}" is a reserved dist-tag` };
  return { ok: true, tag: channel };
}
