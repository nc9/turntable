// The label maps a job's org and project set (#492), resolved through the settings registry
// (environment, `turntable.toml`, then the database), most specific first. `sizeFor` applies them
// over the operator's instance map; the operator's classes and ceilings bound every one.
import type { Db } from "../db";
import { getOrgById } from "../db/repos/api";
import { getProject } from "../db/repos";
import type { Scope } from "../db/repos/scope";
import { ambientSettings } from "../settings/ambient";
import { orgRunnerLabelsSetting, projectRunnerLabelsSetting } from "../settings/definitions";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import type { LabelMap } from "./sandbox-size";

export async function resolveRunnerLabelMaps(
  db: Db,
  scope: Required<Scope>,
  rt: SettingsRuntime = ambientSettings(),
): Promise<LabelMap[]> {
  const org = await getOrgById(db, scope.orgId);
  const project = await getProject(db, scope, scope.projectId);
  const projectValue = (
    await resolveSetting(rt, db, projectRunnerLabelsSetting.key, {
      orgId: scope.orgId,
      projectId: scope.projectId,
      ...(org ? { orgSlug: org.slug } : {}),
      ...(project ? { projectSlug: project.slug } : {}),
    })
  ).value as LabelMap;
  const orgValue = (
    await resolveSetting(rt, db, orgRunnerLabelsSetting.key, {
      orgId: scope.orgId,
      ...(org ? { orgSlug: org.slug } : {}),
    })
  ).value as LabelMap;
  return [projectValue, orgValue];
}
