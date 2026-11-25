// `scripts/build.ts` replaces these at compile time via --define.
declare const TURNTABLE_BUILD_VERSION: string | undefined;

declare const TURNTABLE_BUILD_SHA: string | undefined;

declare const TURNTABLE_BUILD_TIME: string | undefined;

// Versions are compared with `===` only. Semver precedence would sort dev10 before dev9, so
// nothing in Turntable may order or sort versions.

// The base of the no-define fallback. A test fails when it disagrees with root package.json,
// the one place the base version is defined.
const FALLBACK_BASE = "0.1.0";

export const VERSION: string =
  typeof TURNTABLE_BUILD_VERSION === "string"
    ? TURNTABLE_BUILD_VERSION
    : `${FALLBACK_BASE}-dev0+unknown`;

// The commit the build came from (the BUILD_SHA file CD stamps into the image), or "unknown".
export const BUILD_SHA: string =
  typeof TURNTABLE_BUILD_SHA === "string" && TURNTABLE_BUILD_SHA !== ""
    ? TURNTABLE_BUILD_SHA
    : "unknown";

// SOURCE_DATE_EPOCH or HEAD's committer date at build time (never the wall clock), or "unknown".
export const BUILD_TIME: string =
  typeof TURNTABLE_BUILD_TIME === "string" && TURNTABLE_BUILD_TIME !== ""
    ? TURNTABLE_BUILD_TIME
    : "unknown";

/** Semver 2.0.0, strict. A test asserts this equals `VERSION_RE` in scripts/build-version.ts. */
export const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Boot check: `serve` refuses to start on a malformed baked version. */
export function assertValidVersion(version: string = VERSION): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid build version ${JSON.stringify(version)}: not a semver 2.0.0 string`);
  }
}
