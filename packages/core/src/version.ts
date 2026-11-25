// `scripts/build.ts` replaces TURNTABLE_BUILD_VERSION at compile time via --define.
declare const TURNTABLE_BUILD_VERSION: string | undefined;

declare const TURNTABLE_BUILD_SHA: string | undefined;

export const VERSION: string =
  typeof TURNTABLE_BUILD_VERSION === "string" ? TURNTABLE_BUILD_VERSION : "0.0.0-dev";

// The commit the build came from (the BUILD_SHA file CD stamps into the image), or "unknown".
export const BUILD_SHA: string =
  typeof TURNTABLE_BUILD_SHA === "string" && TURNTABLE_BUILD_SHA !== ""
    ? TURNTABLE_BUILD_SHA
    : "unknown";
