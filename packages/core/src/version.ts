// `scripts/build.ts` replaces LONGSHORE_BUILD_VERSION at compile time via --define.
declare const LONGSHORE_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof LONGSHORE_BUILD_VERSION === "string" ? LONGSHORE_BUILD_VERSION : "0.0.0-dev";
