// `scripts/build.ts` replaces TURNTABLE_BUILD_VERSION at compile time via --define.
declare const TURNTABLE_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof TURNTABLE_BUILD_VERSION === "string" ? TURNTABLE_BUILD_VERSION : "0.0.0-dev";
