// Presentation helpers for the settings pages. The server owns every rule (lock, role, type), so
// nothing here validates a value: it only turns what a person typed into what the op is sent.
import { ApiError } from "@/api/http-adapter";
import type { Setting, SettingSource, StepUpProof } from "@/api/types";
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
  // The registry's `instance_admin` role is no org role: nobody signed in to an org holds it.
  if ((s.role as string) === "instance_admin")
    return { editable: false, reason: "Only the instance administrator can change this setting." };
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

/** Whether `value` is looser than the effective value, for a setting with a strictness order. */
export function loosens(s: Setting, value: unknown): boolean {
  return s.strictness !== undefined && strictRank(s, value) < strictRank(s, s.value);
}

/**
 * Whether an org user may pick `value`. A trust setting may be loosened with a passkey
 * confirmation (the page asks for it); any other setting with an order never loosens here.
 */
export function pickable(s: Setting, value: unknown): boolean {
  return s.trust === "tighten_only" || !loosens(s, value);
}

/** Whether saving needs a passkey confirmation first: loosening a trust setting. */
export function needsStepUp(s: Setting, change: { draft: string } | { unset: true }): boolean {
  if (s.trust !== "tighten_only") return false;
  return loosens(s, "unset" in change ? s.default : valueOfDraft(s, change.draft));
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
    stepUp?: StepUpProof;
  }) => Promise<Setting>,
  s: Setting,
  change: { draft: string } | { unset: true },
  project?: string,
  /** Confirms with a passkey for exactly these arguments; absent where there are no passkeys. */
  confirm?: (args: Record<string, unknown>) => Promise<StepUpProof>,
): Promise<SaveResult> {
  const args = {
    key: s.key,
    ...("unset" in change ? { unset: true as const } : { value: valueOfDraft(s, change.draft) }),
    ...(project !== undefined ? { project } : {}),
  };
  try {
    // A loosening of a trust setting asks for the passkey first; for any other setting the server
    // says when it wants one (`step_up_required`) and the page asks then.
    if (confirm && needsStepUp(s, change)) {
      return { ok: true, setting: await save({ ...args, stepUp: await confirm(args) }) };
    }
    try {
      return { ok: true, setting: await save(args) };
    } catch (e) {
      if (!confirm || !(e instanceof ApiError) || e.reason !== "step_up_required") throw e;
      return { ok: true, setting: await save({ ...args, stepUp: await confirm(args) }) };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The change was not accepted." };
  }
}
