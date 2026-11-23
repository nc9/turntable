// Presentation helpers for the settings pages. The server owns every rule (lock, role, type), so
// nothing here validates a value: it only turns what a person typed into what the op is sent.
import type { Setting, SettingSource } from "@/api/types";
import { meetsRole, roleLabel, type Role } from "@/lib/roles";

export const SOURCE_LABEL: Record<SettingSource, string> = {
  env: "env",
  toml: "toml",
  db: "ui/db",
  default: "default",
};

/** Where a locked setting is set, in the words the server's refusal uses. Null when unlocked. */
export function lockNote(s: Setting): string | null {
  if (!s.locked) return null;
  if (s.source === "env") return `Set by ${s.lockedBy ?? "the environment"}`;
  return "Set in turntable.toml";
}

/** The least role that may call `set_setting` at all; each setting can ask for more. */
const SET_MIN_ROLE: Role = "operator";

/** Whether the caller may change a setting, and a plain-language reason when not. */
export function editability(
  role: Role | null,
  s: Setting,
): { editable: boolean; reason: string | null } {
  const lock = lockNote(s);
  if (lock) return { editable: false, reason: `${lock}. Change it there.` };
  if (role === null) return { editable: false, reason: "Checking your role." };
  const need = meetsRole(s.role, SET_MIN_ROLE) ? s.role : SET_MIN_ROLE;
  if (!meetsRole(role, need))
    return {
      editable: false,
      reason: `Changing this needs the ${roleLabel(need)} role or higher. You are signed in as ${roleLabel(role)}.`,
    };
  return { editable: true, reason: null };
}

/** Position in the setting's strictness order; a value it does not list ranks strictest. */
function strictRank(s: Setting, v: unknown): number {
  const order = s.strictness ?? [];
  const i = order.indexOf(v as string);
  return i < 0 ? order.length : i;
}

/** Whether an org user may pick `value`: never one looser than the effective value. */
export function loosens(s: Setting, value: unknown): boolean {
  return s.strictness !== undefined && strictRank(s, value) < strictRank(s, s.value);
}

export type SettingKind = "boolean" | "number" | "text" | "json";

/** The editor to offer, from the shape of the default: the list op does not send the type. */
export function kindOf(s: Setting): SettingKind {
  switch (typeof s.default) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "text";
    default:
      return "json";
  }
}

export function formatValue(v: unknown): string {
  if (typeof v === "string") return v === "" ? '""' : v;
  return JSON.stringify(v) ?? String(v);
}

/** The text an editor starts with for a value. */
export function draftOf(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
}

/**
 * What to send for a draft. Text that does not read as the kind is sent as typed, so the server
 * refuses it in its own words instead of this page guessing.
 */
export function valueOfDraft(s: Setting, draft: string): unknown {
  const kind = kindOf(s);
  if (kind === "text") return draft;
  if (kind === "boolean") return draft === "true" ? true : draft === "false" ? false : draft;
  const t = draft.trim();
  if (kind === "number") return t !== "" && Number.isFinite(Number(t)) ? Number(t) : draft;
  try {
    return JSON.parse(draft) as unknown;
  } catch {
    return draft;
  }
}

export type SaveResult = { ok: true; setting: Setting } | { ok: false; message: string };

/** Calls `set_setting` and returns the server's refusal text unchanged. */
export async function saveSetting(
  save: (a: {
    key: string;
    value?: unknown;
    unset?: boolean;
    project?: string;
  }) => Promise<Setting>,
  s: Setting,
  change: { draft: string } | { unset: true },
  project?: string,
): Promise<SaveResult> {
  try {
    const setting = await save({
      key: s.key,
      ...("unset" in change ? { unset: true } : { value: valueOfDraft(s, change.draft) }),
      ...(project !== undefined ? { project } : {}),
    });
    return { ok: true, setting };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The change was not accepted." };
  }
}
