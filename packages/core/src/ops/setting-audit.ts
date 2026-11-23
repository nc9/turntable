// The audit and event every write of a setting leaves (#321, #345), shared by `set_setting` and
// the commands that alias a setting, so no path writes a value without them. A change that
// weakens a protection (the definition's `loosens`) is marked in every chain it is written to and
// emits an event, so a person watching the feed or a webhook sees it without reading the audit.
import { appendAudit, appendEvent } from "../db/repos";
import type { Db } from "../db";
import type { Scope } from "../db/repos/scope";
import type { SettingDef } from "../settings/define";

export type SettingChange = {
  def: SettingDef;
  /** The org the setting is about: its chain and its event feed. Absent for an instance setting. */
  orgId?: string | undefined;
  /** Every chain the change is written to: the caller's own, then the target's. */
  chains: readonly Scope[];
  principalKind: string;
  principalId: string;
  /** The effective values before and after, and the layer the new one came from. */
  from: unknown;
  to: unknown;
  source: string;
};

/** The ways the change weakens a protection; empty for a change that does not. */
export function settingLoosening(def: SettingDef, from: unknown, to: unknown): string[] {
  return def.loosens ? def.loosens(from, to) : [];
}

/** Call inside the transaction that wrote the value, so a rolled-back write leaves neither. */
export async function recordSettingChange(db: Db, c: SettingChange): Promise<string[]> {
  const loosened = settingLoosening(c.def, c.from, c.to);
  const entry = {
    principalKind: c.principalKind,
    principalId: c.principalId,
    op: "setting_changed",
    effect: "write",
    outcome: "ok",
    input: {
      key: c.def.key,
      from: c.from,
      to: c.to,
      source: c.source,
      ...(loosened.length > 0 ? { loosened } : {}),
    },
  } as const;
  for (const scope of c.chains) await appendAudit(db, scope, entry);
  if (loosened.length > 0 && c.orgId) {
    await appendEvent(
      db,
      { orgId: c.orgId },
      {
        type: "approval.policy_loosened",
        payload: { setting: c.def.key, loosened, by: c.principalId },
      },
    );
  }
  return loosened;
}
