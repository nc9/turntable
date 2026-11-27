// The size budgets one project's checkouts run under (#677): the project's override (0 or unset
// means none), else the instance value, each as the registry resolves it (environment, then
// `turntable.toml`, then the stored value, then the default). The project's value is clamped to the
// instance ceiling, so a stored value from before the ceiling was lowered fails closed. The result
// is the SHALLOW tree's budgets; `limitsFor` multiplies them for a full-history delivery.
import type { Db } from "../db";
import { projectSubject } from "../ops/setting-guard";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import type { FetchLimits } from "./git-fetch";

const MIB = 1024 * 1024;

const BUDGETS = [
  ["maxPackBytes", "pack"],
  ["maxInflatedBytes", "unpacked"],
  ["maxTarballBytes", "tarball"],
] as const;

/** Only the three budgets, in bytes. Each is the project's, the instance's or the default. */
export async function effectiveCheckoutLimits(
  rt: SettingsRuntime,
  db: Db,
  orgId: string,
  projectId: string,
): Promise<Pick<FetchLimits, "maxPackBytes" | "maxInflatedBytes" | "maxTarballBytes">> {
  const subject = await projectSubject(db, orgId, projectId);
  const out = {} as Record<string, number>;
  for (const [field, name] of BUDGETS) {
    const instance = (await resolveSetting(rt, db, `checkout_max_${name}_mib`, {})).value as number;
    const ceiling = (await resolveSetting(rt, db, `checkout_ceiling_${name}_mib`, {}))
      .value as number;
    const project = (await resolveSetting(rt, db, `project_checkout_max_${name}_mib`, subject))
      .value as number;
    // A project override is bounded by the ceiling; the instance value is the operator's own and
    // is not (it may be above the ceiling, which limits only per-project overrides).
    const mib = project > 0 ? Math.min(project, ceiling) : instance;
    out[field] = mib * MIB;
  }
  return out as never;
}
