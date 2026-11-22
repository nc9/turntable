// The feed cursor, kept in a file so a restart resumes where the last session stopped.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CursorStore = { load(): number | null; save(cursor: number): void };

export function defaultStatePath(url: string, org: string, projects: readonly string[]): string {
  const key = createHash("sha256")
    .update([url, org, projects.toSorted().join(",")].join("\n"))
    .digest("hex")
    .slice(0, 16);
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, "longshore", `channel-${key}.json`);
}

export function fileCursorStore(path: string): CursorStore {
  return {
    load() {
      try {
        const v = (JSON.parse(readFileSync(path, "utf8")) as { cursor?: unknown }).cursor;
        return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
      } catch {
        return null;
      }
    },
    save(cursor) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cursor }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
  };
}

export function memoryCursorStore(
  initial: number | null = null,
): CursorStore & { value(): number | null } {
  let v = initial;
  return { load: () => v, save: (c) => void (v = c), value: () => v };
}
