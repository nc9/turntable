// The per-org concurrency ceiling `set_quotas` and its aliases clamp to (#661). It is the live
// `scheduler_org_cap` setting, read when the op runs, so an instance administrator who raises it
// can raise an org's quota at once. A context with no settings runtime (the offline CLI) has no
// cap unless the caller fixed one in `instanceOrgCap`.
import { schedulerOrgCapSetting } from "../settings/definitions";
import { resolveSetting } from "../settings/resolve";
import type { OpContext } from "./define";

export async function instanceOrgCapOf(ctx: OpContext): Promise<number | undefined> {
  if (ctx.instanceOrgCap !== undefined) return ctx.instanceOrgCap;
  if (!ctx.settings) return undefined;
  return (await resolveSetting(ctx.settings, ctx.db, schedulerOrgCapSetting.key)).value as number;
}
