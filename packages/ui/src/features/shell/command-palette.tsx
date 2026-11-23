import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  CircleHelp,
  GitBranch,
  LayoutDashboard,
  Moon,
  PlayCircle,
  Settings,
  Gauge,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { StateIcon } from "@/components/state-badge";
import { useTheme } from "@/components/theme";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandRoot,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { runsCollection } from "@/db/collections";
import { branchFromRef, shortSha } from "@/lib/format";
import { useScope } from "./scope";

export function CommandPalette({
  open,
  onOpenChange,
  onHelp,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onHelp: () => void;
}) {
  const scope = useScope();
  const navigate = useNavigate();
  const { toggle } = useTheme();
  const [query, setQuery] = useState("");
  const { data: runs } = useLiveQuery(
    (q) =>
      q
        .from({ run: runsCollection })
        .orderBy(({ run }) => run.createdAt, "desc")
        .limit(60),
    [],
  );

  const close = () => {
    onOpenChange(false);
    setQuery("");
  };
  const go = (fn: () => void) => () => {
    close();
    fn();
  };
  const orgSlug = scope.orgSlug;
  const projectSlug = scope.projectSlug;
  const recent = (runs ?? [])
    .filter((r) =>
      scope.project
        ? r.projectId === scope.project.id
        : scope.org
          ? r.orgId === scope.org.id
          : true,
    )
    .slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        className="top-[18%] max-w-xl translate-y-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to a page, project or run.</DialogDescription>
        <CommandRoot label="Command palette" loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search runs, projects and actions"
          />
          <CommandList>
            <CommandEmpty>No matches. Try a branch, sha or project name.</CommandEmpty>
            {orgSlug ? (
              <CommandGroup heading="Go to">
                <CommandItem
                  value="overview org"
                  onSelect={go(() => void navigate({ to: "/$org", params: { org: orgSlug } }))}
                >
                  <LayoutDashboard />
                  Org overview
                </CommandItem>
                {(scope.projects ?? []).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`project ${p.name} ${p.repo}`}
                    onSelect={go(
                      () =>
                        void navigate({
                          to: "/$org/$project",
                          params: { org: orgSlug, project: p.slug },
                        }),
                    )}
                  >
                    <PlayCircle />
                    {p.name} runs
                  </CommandItem>
                ))}
                <CommandItem
                  value="ingest status"
                  onSelect={go(
                    () => void navigate({ to: "/$org/-/ingest", params: { org: orgSlug } }),
                  )}
                >
                  <Activity />
                  Ingest status
                </CommandItem>
                <CommandItem
                  value="approvers"
                  onSelect={go(
                    () => void navigate({ to: "/$org/-/approvers", params: { org: orgSlug } }),
                  )}
                >
                  <ShieldCheck />
                  Approvers
                </CommandItem>
                <CommandItem
                  value="quotas"
                  onSelect={go(
                    () => void navigate({ to: "/$org/-/quotas", params: { org: orgSlug } }),
                  )}
                >
                  <Gauge />
                  Quotas
                </CommandItem>
                {projectSlug ? (
                  <CommandItem
                    value="settings"
                    onSelect={go(
                      () =>
                        void navigate({
                          to: "/$org/$project/settings",
                          params: { org: orgSlug, project: projectSlug },
                        }),
                    )}
                  >
                    <Settings />
                    Project settings
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}
            {orgSlug && projectSlug ? (
              <CommandGroup heading="Filter runs">
                {(["failure", "running", "infra_error"] as const).map((status) => (
                  <CommandItem
                    key={status}
                    value={`filter ${status}`}
                    onSelect={go(
                      () =>
                        void navigate({
                          to: "/$org/$project",
                          params: { org: orgSlug, project: projectSlug },
                          search: { status },
                        }),
                    )}
                  >
                    <StateIcon state={status} />
                    Show{" "}
                    {status === "infra_error"
                      ? "infra errors"
                      : status === "failure"
                        ? "failed"
                        : status}{" "}
                    runs
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {orgSlug && projectSlug && recent.length > 0 ? (
              <CommandGroup heading="Recent runs">
                {recent.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={`run ${r.commitMessage} ${branchFromRef(r.ref)} ${shortSha(r.sha)} ${r.workflowName}`}
                    onSelect={go(
                      () =>
                        void navigate({
                          to: "/$org/$project/runs/$runId",
                          params: { org: orgSlug, project: projectSlug, runId: r.id },
                        }),
                    )}
                  >
                    <StateIcon state={r.status} className="!size-4" />
                    <span className="min-w-0 flex-1 truncate">{r.commitMessage}</span>
                    <span className="hidden items-center gap-1 text-xs text-faint sm:flex">
                      <GitBranch className="!size-3" />
                      {branchFromRef(r.ref)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandGroup heading="Actions">
              <CommandItem value="toggle theme dark light" onSelect={go(toggle)}>
                <Moon />
                Toggle theme
              </CommandItem>
              <CommandItem value="keyboard shortcuts help" onSelect={go(onHelp)}>
                <CircleHelp />
                Keyboard shortcuts
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandRoot>
      </DialogContent>
    </Dialog>
  );
}
