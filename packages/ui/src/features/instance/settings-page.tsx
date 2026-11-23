import { getInstanceApi } from "@/api/instance";
import { SettingsList } from "@/features/settings/settings-section";
import { Page, PageHeader } from "./parts";

/**
 * Instance settings, generated from `instance_list_settings` exactly as the org page is from
 * `list_settings`: effective value, source badge, lock text, and the server's refusal verbatim.
 */
export function InstanceSettingsPage() {
  const api = getInstanceApi();
  return (
    <Page>
      <PageHeader title="Instance settings">
        A value set by the environment or <span className="font-mono">turntable.toml</span> is
        locked here. Change it there.
      </PageHeader>
      <div className="mt-6">
        <SettingsList
          deps={[]}
          source={{
            list: () => api.listSettings(),
            set: (a) => api.setSetting(a),
            // The token is the instance administrator: there is no org role to check, and the
            // server enforces each setting anyway.
            role: "owner",
            noun: "instance",
          }}
        />
      </div>
    </Page>
  );
}
