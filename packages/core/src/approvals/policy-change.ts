// Setting one environment's approval policy from the host (`turntable approvals policy`, #345).
// The same resolver and the same audit as the settings ops: a locked policy is refused, the new
// map is validated by the setting's own type, and the change is written to the system chain and
// the org's with the old and new values, with an event when it loosens anything.
import { systemOrgId } from "../audit/failures";
import type { Db } from "../db";
import { setEnvPolicy } from "../db/repos/approvals";
import { recordSettingChange } from "../ops/setting-audit";
import { approvalPolicySetting } from "../settings/definitions";
import type { SettingsRuntime } from "../settings/resolve";
import type { KeyPolicyMode } from "./key-policy";
import type { ApprovalPolicyMap } from "./policy-setting";

export type EnvPolicyChange = {
  environment: string;
  required: number;
  allowAuthorApproval: boolean;
  /** Left as it was when absent. */
  keyPolicy?: KeyPolicyMode | undefined;
  now: number;
  rt?: SettingsRuntime | undefined;
};

export async function changeEnvPolicy(
  db: Db,
  org: { id: string },
  c: EnvPolicyChange,
): Promise<{ after: ApprovalPolicyMap; loosened: string[] }> {
  const system = await systemOrgId(db);
  return db.transaction(async (tx) => {
    const { before, after } = await setEnvPolicy(tx, org.id, {
      environment: c.environment,
      required: c.required,
      allowAuthorApproval: c.allowAuthorApproval,
      ...(c.keyPolicy ? { keyPolicy: c.keyPolicy } : {}),
      by: "cli",
      now: c.now,
      ...(c.rt ? { rt: c.rt } : {}),
    });
    const loosened = await recordSettingChange(tx, {
      def: approvalPolicySetting,
      orgId: org.id,
      chains: [{ orgId: system }, { orgId: org.id }],
      principalKind: "cli",
      principalId: "local",
      from: before,
      to: after,
      source: "db",
    });
    return { after, loosened };
  });
}
