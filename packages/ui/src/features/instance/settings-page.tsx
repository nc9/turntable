import { useState } from "react";
import { getInstanceApi, type EffectiveConcurrency } from "@/api/instance";
import { useAsync } from "@/lib/use-async";
import { SettingsList } from "@/features/settings/settings-section";
import { Page, PageHeader } from "./parts";

/** What the limits allow together: the lower of the global cap and the provider's max live. */
export function EffectiveConcurrencyNote({ c }: { c: EffectiveConcurrency }) {
  return (
    <section
      aria-label="Effective concurrency"
      className="mt-6 rounded-md border border-line p-3 text-sm"
    >
      <p>
        Effective concurrency: <strong data-testid="effective-concurrency">{c.value}</strong> jobs
        at once, bounded by <span className="font-mono">{c.boundedBy}</span>. No org runs more than{" "}
        {c.orgCap}; a new sandbox waits above {c.cpuLimit} vCPU in use.
      </p>
      <p className="mt-1 text-dim">{c.note}</p>
    </section>
  );
}

/**
 * Instance settings, generated from `instance_list_settings` exactly as the org page is from
 * `list_settings`: effective value, source badge, lock text, and the server's refusal verbatim.
 */
export function InstanceSettingsPage() {
  const api = getInstanceApi();
  const [saved, setSaved] = useState(0);
  const eff = useAsync(() => api.sandboxLimits(), [saved]);
  return (
    <Page>
      <PageHeader title="Instance settings">
        A value set by the environment or <span className="font-mono">turntable.toml</span> is
        locked here. Change it there.
      </PageHeader>
      {eff.data ? <EffectiveConcurrencyNote c={eff.data} /> : null}
      <div className="mt-6">
        <SettingsList
          deps={[]}
          source={{
            list: () => api.listSettings(),
            set: async (a) => {
              const r = await api.setSetting(a);
              setSaved((n) => n + 1);
              return r;
            },
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
