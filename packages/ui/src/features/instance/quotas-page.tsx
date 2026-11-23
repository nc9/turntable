import { useState } from "react";
import { getInstanceApi, type QuotaPatch } from "@/api/instance";
import type { OrgQuotas } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatQuotaValue, QUOTA_ROWS } from "@/lib/quota";
import { sanitize } from "@/log/parser";
import { OrgSelect, Page, PageHeader, Refusal, TextField } from "./parts";
import { parseLimit, useAction } from "./use-action";

/** Orgs and their quotas: `instance_list_orgs` for the choice, `set_quotas` for the change. */
export function InstanceQuotasPage() {
  const api = getInstanceApi();
  const [org, setOrg] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ org: string; quotas: OrgQuotas } | null>(null);
  const save = useAction(async (target: string, patch: QuotaPatch) =>
    api.setQuotas({ org: target, patch }),
  );

  async function submit() {
    const patch: Record<string, unknown> = {};
    for (const row of QUOTA_ROWS) {
      const v = parseLimit(drafts[row.field] ?? "");
      if (v !== undefined) patch[row.field] = v;
    }
    const quotas = await save.run(org, patch as QuotaPatch);
    if (quotas) {
      setResult({ org, quotas });
      setDrafts({});
    }
  }

  return (
    <Page>
      <PageHeader title="Orgs and quotas">
        Name only the limits to change. Leave a field blank to keep it, or type{" "}
        <span className="font-mono">none</span> to remove it. Concurrency can only lower the
        instance's per-org cap.
      </PageHeader>
      <form
        className="mt-6 space-y-4 rounded-xl border border-line p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <OrgSelect id="quota-org" value={org} onChange={setOrg} />
        {QUOTA_ROWS.map((row) => (
          <TextField
            key={row.field}
            id={`quota-${row.field}`}
            label={row.label}
            hint={row.note}
            mono
            placeholder="unchanged"
            value={drafts[row.field] ?? ""}
            onChange={(v) => setDrafts((d) => ({ ...d, [row.field]: v }))}
          />
        ))}
        <Button type="submit" disabled={save.busy || org === ""}>
          {save.busy ? "Saving" : "Set quotas"}
        </Button>
        <Refusal message={save.error} />
      </form>
      {result ? (
        <section aria-label="Quotas now" className="mt-6" data-result="quotas">
          <h2 className="text-sm font-semibold">
            Limits of <span className="font-mono">{sanitize(result.org)}</span> now
          </h2>
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {QUOTA_ROWS.map((row) => {
              const u = result.quotas.usage.find((x) => x.metric === row.metric);
              const limit = result.quotas.limits[row.field];
              return (
                <li key={row.field} className="flex flex-wrap gap-x-3 px-4 py-2.5 text-sm">
                  <span className="font-medium">{row.label}</span>
                  <span className="tabular ml-auto text-dim">
                    {limit === null ? "no limit" : formatQuotaValue(limit, row.unit)}
                    {u ? `, ${formatQuotaValue(u.used, row.unit)} used` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}
