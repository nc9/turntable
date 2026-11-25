import type { ChecksMode, InstallationRepo } from "@/api/onboarding";
import { CHECKS_MODE_LABELS, CHECKS_MODES, initialChoice, type RepoChoice } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

export type RepoTableProps = {
  repos: readonly InstallationRepo[];
  choices: Readonly<Record<string, RepoChoice>>;
  onChange: (repoId: string, next: RepoChoice) => void;
  disabled?: boolean;
};

/** One row per repo the installation grants: a tick box, new or already in the org, and a mode. */
export function RepoTable({ repos, choices, onChange, disabled }: RepoTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-subtle text-xs text-dim">
          <tr>
            <th scope="col" className="w-10 px-3 py-2">
              <span className="sr-only">Enable CI</span>
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Repository
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              GitHub checks
            </th>
          </tr>
        </thead>
        <tbody>
          {repos.map((r) => {
            const c = choices[r.repo_id] ?? initialChoice(r);
            return (
              <tr key={r.repo_id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={c.ticked}
                    disabled={disabled}
                    aria-label={`Enable CI for ${r.repo}`}
                    onChange={(e) => onChange(r.repo_id, { ...c, ticked: e.target.checked })}
                  />
                </td>
                <td className="px-3 py-2">
                  <span className="font-mono text-[13px]">{r.repo}</span>
                  {r.private ? <span className="ml-2 text-xs text-faint">private</span> : null}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs",
                      r.status === "new" ? "bg-st-running-bg text-st-running" : "bg-muted text-dim",
                    )}
                  >
                    {r.status === "new" ? "new" : "already in this org"}
                  </span>
                  {r.status === "in_org" && r.paused ? (
                    <span className="ml-2 text-xs text-faint">paused</span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={c.mode}
                    disabled={disabled}
                    aria-label={`Checks mode for ${r.repo}`}
                    className="h-8 w-full max-w-xs rounded-md border border-line-strong bg-surface px-2 text-[13px]"
                    onChange={(e) =>
                      onChange(r.repo_id, {
                        ...c,
                        mode: e.target.value as ChecksMode,
                        modeTouched: true,
                      })
                    }
                  >
                    {CHECKS_MODES.map((m) => (
                      <option key={m} value={m}>
                        {CHECKS_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
