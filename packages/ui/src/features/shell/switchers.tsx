import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Layers } from "lucide-react";
import { useState } from "react";
import { OrgAvatar, ProjectAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandRoot,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { lastOrg, lastProject, rememberOrg, rememberProject } from "@/lib/last-org";
import { filterValue, orgTarget, projectTarget, withLastFirst, type Item } from "@/lib/switcher";
import { useScope } from "./scope";

/** The filterable list inside a switcher (also rendered on its own by the tests). */
export function SwitcherList({
  label,
  allLabel,
  allSelected,
  items,
  isSelected,
  icon,
  onPick,
}: {
  label: string;
  allLabel: string;
  allSelected: boolean;
  items: Item[] | null;
  isSelected: (i: Item) => boolean;
  icon: (i: Item) => React.ReactNode;
  onPick: (i: Item | null) => void;
}) {
  return (
    <CommandRoot label={`Switch ${label.toLowerCase()}`}>
      <CommandInput placeholder={`Find ${label.toLowerCase()}`} className="h-10 text-sm" />
      <CommandList>
        <CommandEmpty>{items === null ? "Loading" : "No match"}</CommandEmpty>
        <CommandGroup>
          <CommandItem value={`__all ${allLabel}`} onSelect={() => onPick(null)}>
            <Layers aria-hidden="true" />
            <span className="flex-1 truncate">{allLabel}</span>
            {allSelected ? <Check className="text-accent" aria-hidden="true" /> : null}
          </CommandItem>
          {(items ?? []).map((i) => (
            <CommandItem key={i.slug} value={filterValue(i)} onSelect={() => onPick(i)}>
              {icon(i)}
              <span className="flex-1 truncate">{i.name}</span>
              {isSelected(i) ? <Check className="text-accent" aria-hidden="true" /> : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandRoot>
  );
}

/**
 * One switcher: a button that opens a type-to-filter list (arrow keys move, Enter picks, Escape
 * closes). Names are only ever text children, so a hostile org or project name is inert.
 */
function Switcher({
  label,
  current,
  allLabel,
  allSelected,
  items,
  isSelected,
  onPick,
  icon,
  disabled = false,
  disabledNote,
  testId,
  footer,
}: {
  footer?: (close: () => void) => React.ReactNode;
  label: string;
  current: React.ReactNode;
  allLabel: string;
  allSelected: boolean;
  items: Item[] | null;
  isSelected: (i: Item) => boolean;
  onPick: (i: Item | null) => void;
  icon: (i: Item) => React.ReactNode;
  disabled?: boolean;
  disabledNote?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-switcher={testId}
          className="max-w-[40vw] gap-1.5 px-2 text-sm text-foreground sm:max-w-56"
          aria-label={`${label}: ${typeof current === "string" ? current : ""}. Switch ${label.toLowerCase()}`}
          {...(disabled && disabledNote ? { title: disabledNote } : {})}
        >
          {current}
          <ChevronsUpDown className="size-3.5 text-faint" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <SwitcherList
          label={label}
          allLabel={allLabel}
          allSelected={allSelected}
          items={items}
          isSelected={isSelected}
          icon={icon}
          onPick={(i) => {
            setOpen(false);
            onPick(i);
          }}
        />
        {footer?.(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

export function OrgSwitcher() {
  const scope = useScope();
  const navigate = useNavigate();
  const items = scope.orgs ? withLastFirst(scope.orgs, lastOrg()) : null;
  const name = scope.org?.name ?? scope.orgSlug;
  return (
    <Switcher
      testId="org"
      footer={(close) => (
        <div className="border-t border-line p-1">
          <button
            type="button"
            className="flex h-8 w-full items-center rounded-sm px-2 text-sm hover:bg-muted"
            onClick={() => {
              close();
              void navigate({ to: "/onboarding" });
            }}
          >
            Connect repositories
          </button>
        </div>
      )}
      label="Organization"
      current={
        scope.orgSlug ? (
          <>
            <OrgAvatar slug={scope.orgSlug} name={name ?? scope.orgSlug} className="size-4" />
            <span className="truncate">{name}</span>
          </>
        ) : (
          <>
            <Layers className="size-4 text-dim" aria-hidden="true" />
            <span className="truncate">All orgs</span>
          </>
        )
      }
      allLabel="All orgs"
      allSelected={scope.orgSlug === null}
      items={items}
      isSelected={(i) => i.slug === scope.orgSlug}
      icon={(i) => <OrgAvatar slug={i.slug} name={i.name} />}
      onPick={(i) => {
        if (i) rememberOrg(i.slug);
        void navigate({ to: orgTarget(i ? i.slug : null) });
      }}
    />
  );
}

export function ProjectSwitcher() {
  const scope = useScope();
  const navigate = useNavigate();
  const org = scope.orgSlug;
  const items = org && scope.projects ? withLastFirst(scope.projects, lastProject(org)) : null;
  const name = scope.project?.name ?? scope.projectSlug;
  return (
    <Switcher
      testId="project"
      label="Project"
      current={
        org && scope.projectSlug ? (
          <>
            <ProjectAvatar
              org={org}
              slug={scope.projectSlug}
              name={name ?? scope.projectSlug}
              className="size-4"
            />
            <span className="truncate">{name}</span>
          </>
        ) : (
          <span className="truncate text-dim">All projects</span>
        )
      }
      allLabel="All projects"
      allSelected={scope.projectSlug === null}
      items={items}
      isSelected={(i) => i.slug === scope.projectSlug}
      icon={(i) => <ProjectAvatar org={org ?? ""} slug={i.slug} name={i.name} />}
      disabled={org === null}
      disabledNote="Pick an organization first"
      onPick={(i) => {
        if (!org) return;
        if (i) rememberProject(org, i.slug);
        void navigate({ to: projectTarget(org, i ? i.slug : null) });
      }}
    />
  );
}
