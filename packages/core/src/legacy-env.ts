// The product was called Longshore for a few days. Its environment variables were LONGSHORE_*; they
// are TURNTABLE_* again. The rename script leaves this file alone, so the old names stay readable.

type Env = Record<string, string | undefined>;

const OLD = "LONGSHORE_";
const NEW = "TURNTABLE_";

/**
 * Moves every LONGSHORE_* variable to its TURNTABLE_* name, in place, and warns once per variable.
 * The rest of the code reads only TURNTABLE_*, so there is no second lookup to forget. If both are
 * set, TURNTABLE_* wins. The old variable is removed so a child process or a prefix scrub never
 * sees a second spelling. Only names are logged, never values. Returns the old names it moved.
 */
export function applyLegacyEnv(
  env: Env = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): string[] {
  const moved: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(OLD)) continue;
    const next = NEW + name.slice(OLD.length);
    const value = env[name];
    delete env[name];
    moved.push(name);
    if (env[next] !== undefined) {
      warn(`[turntable] ${name} is ignored: ${next} is set and wins. Remove ${name}.`);
      continue;
    }
    if (value !== undefined) env[next] = value;
    warn(`[turntable] ${name} is deprecated: it was read as ${next}. Rename the variable.`);
  }
  return moved;
}
