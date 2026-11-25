// Who may create an org for themselves (`self_serve_orgs`, `self_serve_org_logins`). One answer
// for the two places that ask: sign-in (a GitHub account with no org may still get a session)
// and `onboarding_create_org`.
import type { Db } from "../db";
import { ambientSettings } from "../settings/ambient";
import { selfServeOrgLoginsSetting, selfServeOrgsSetting } from "../settings/definitions";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";

export async function selfServeAllows(
  settings: SettingsRuntime | undefined,
  db: Db,
  login: string,
): Promise<boolean> {
  const rt = settings ?? ambientSettings();
  const mode = (await resolveSetting(rt, db, selfServeOrgsSetting.key)).value as string;
  if (mode === "any") return true;
  if (mode !== "allowlist") return false;
  const logins = (await resolveSetting(rt, db, selfServeOrgLoginsSetting.key)).value as string[];
  const l = login.toLowerCase();
  return logins.some((x) => x.toLowerCase() === l);
}
