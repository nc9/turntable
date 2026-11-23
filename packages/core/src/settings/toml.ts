// `turntable.toml`: the file layer of the settings registry (#321). Parsed with Bun.TOML and
// checked against the registry at load, so an unknown key or a bad value stops the boot naming the
// key and the file. No file at all is fine: the layer is then empty.
import { readFileSync } from "node:fs";
import type { SettingDef, SettingsRegistry } from "./define";

/** A value found in the file, with where it was written, for errors and for the lock reason. */
export type TomlLayer = {
  /** The file's path, or undefined when no file was given. */
  file: string | undefined;
  instance: Map<string, unknown>;
  /** By org slug. */
  orgs: Map<string, Map<string, unknown>>;
  /** By `<org slug>/<project slug>`. */
  projects: Map<string, Map<string, unknown>>;
};

export const EMPTY_TOML: TomlLayer = {
  file: undefined,
  instance: new Map(),
  orgs: new Map(),
  projects: new Map(),
};

export class SettingsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsConfigError";
  }
}

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** The settings in one TOML section, validated. `at` is the section's name in messages. */
function readSection(
  file: string,
  at: string,
  table: Record<string, unknown>,
  defs: readonly SettingDef[],
  skip: ReadonlySet<string>,
): Map<string, unknown> {
  const byPath = new Map(defs.map((d) => [d.toml, d]));
  const out = new Map<string, unknown>();
  const walk = (t: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(t)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (!prefix && skip.has(k)) continue;
      const def = byPath.get(path);
      if (def) {
        const r = def.type.safeParse(v);
        if (!r.success) {
          throw new SettingsConfigError(
            `${file}: ${at}${path} (setting ${def.key}): ${r.error.issues.map((i) => i.message).join("; ")}`,
          );
        }
        const refused = def.refuse?.(r.data);
        if (refused) {
          throw new SettingsConfigError(`${file}: ${at}${path} (setting ${def.key}): ${refused}`);
        }
        out.set(def.key, r.data);
      } else if (isTable(v) && defs.some((d) => d.toml.startsWith(`${path}.`))) {
        walk(v, path);
      } else {
        throw new SettingsConfigError(`${file}: unknown setting ${at}${path}`);
      }
    }
  };
  walk(table, "");
  return out;
}

/** Validates parsed TOML against the registry. `file` names the source in every error. */
export function readTomlSettings(
  file: string,
  doc: Record<string, unknown>,
  registry: SettingsRegistry,
): TomlLayer {
  const layer: TomlLayer = { file, instance: new Map(), orgs: new Map(), projects: new Map() };
  const sectionOf = (name: string, v: unknown): Record<string, unknown> => {
    if (!isTable(v)) throw new SettingsConfigError(`${file}: ${name} must be a table`);
    return v;
  };
  layer.instance = readSection(file, "", doc, registry.byScope("instance"), new Set(["orgs"]));
  if (doc.orgs !== undefined) {
    for (const [orgSlug, orgRaw] of Object.entries(sectionOf("orgs", doc.orgs))) {
      const at = `orgs.${orgSlug}`;
      const org = sectionOf(at, orgRaw);
      layer.orgs.set(
        orgSlug,
        readSection(file, `${at}.`, org, registry.byScope("org"), new Set(["projects"])),
      );
      if (org.projects === undefined) continue;
      for (const [projectSlug, projectRaw] of Object.entries(
        sectionOf(`${at}.projects`, org.projects),
      )) {
        const pat = `${at}.projects.${projectSlug}`;
        layer.projects.set(
          `${orgSlug}/${projectSlug}`,
          readSection(
            file,
            `${pat}.`,
            sectionOf(pat, projectRaw),
            registry.byScope("project"),
            new Set(),
          ),
        );
      }
    }
  }
  return layer;
}

/**
 * Loads the file at `path`. No path means no file layer. A path that cannot be read or parsed is
 * an error: naming a file that is not there is a typo, not a request for the defaults.
 */
export function loadTomlSettings(
  path: string | undefined,
  registry: SettingsRegistry,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): TomlLayer {
  if (!path) return EMPTY_TOML;
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    throw new SettingsConfigError(
      `${path}: cannot read the config file (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (err) {
    throw new SettingsConfigError(`${path}: not valid TOML (${(err as Error).message})`);
  }
  return readTomlSettings(path, doc as Record<string, unknown>, registry);
}
