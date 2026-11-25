import { Link, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  LayoutDashboard,
  Menu,
  Moon,
  PlayCircle,
  Search,
  Settings,
  Gauge,
  ShieldCheck,
  Sun,
  Wifi,
  WifiOff,
  ChartColumn,
  PackageCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { IncidentBanner } from "./incident-banner";
import { useWhoami } from "@/lib/directory";
import { canConfigureLane } from "@/lib/release-lane";
import { ApprovalNotifyBanner, useApprovalNotifications } from "./approval-notifications";
import { NotificationBell } from "./notification-bell";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme";
import { rememberOrg } from "@/lib/directory";
import { rememberProject } from "@/lib/last-org";
import { Avatar } from "@/components/avatar";
import { modKey, useHotkeys } from "@/lib/hotkeys";
import { dismiss, useToasts } from "@/lib/toast";
import { chooseBackend } from "@/api";
import { disconnect, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ConnectScreen } from "./connect";
import { SignInScreen } from "./sign-in-screen";
import { gateFor, isSessionActive, loadSession, signOut, useSession } from "@/lib/session";
import { resetDirectory } from "@/lib/directory";
import { useConnectionStatus } from "@/db/sync";
import { CommandPalette } from "./command-palette";
import { InstanceShell, isInstancePath } from "@/features/instance/instance-shell";
import { useScope } from "./scope";
import { OrgSwitcher, ProjectSwitcher } from "./switchers";

function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <BrandMark className="size-6" />
      <span className="hidden sm:inline">Turntable</span>
    </span>
  );
}

function NavLink({
  to,
  params,
  icon,
  children,
  active,
  onNavigate,
}: {
  to: string;
  params?: Record<string, string>;
  icon: React.ReactNode;
  children: React.ReactNode;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      {...(params ? { params } : {})}
      onClick={onNavigate}
      activeOptions={{ exact: true }}
      activeProps={{ "aria-current": active ? "page" : undefined }}
      inactiveProps={{ "aria-current": active ? "page" : undefined }}
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-dim transition-colors duration-150 hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-4",
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const scope = useScope();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { orgSlug, projectSlug } = scope;
  const who = useWhoami();
  if (!orgSlug) return null;
  const base = `/${orgSlug}`;
  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 p-3">
      <div className="flex flex-col gap-0.5">
        <NavLink
          to="/$org"
          params={{ org: orgSlug }}
          icon={<LayoutDashboard />}
          active={path === base}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Overview
        </NavLink>
        <NavLink
          to="/$org/-/ingest"
          params={{ org: orgSlug }}
          icon={<Activity />}
          active={path === `${base}/-/ingest`}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Ingest status
        </NavLink>
        <NavLink
          to="/$org/-/approvers"
          params={{ org: orgSlug }}
          icon={<ShieldCheck />}
          active={path === `${base}/-/approvers`}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Approvers
        </NavLink>
        <NavLink
          to="/$org/-/quotas"
          params={{ org: orgSlug }}
          icon={<Gauge />}
          active={path === `${base}/-/quotas`}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Quotas
        </NavLink>
        <NavLink
          to="/$org/-/usage"
          params={{ org: orgSlug }}
          icon={<ChartColumn />}
          active={path === `${base}/-/usage`}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Usage
        </NavLink>
        <NavLink
          to="/$org/-/settings"
          params={{ org: orgSlug }}
          icon={<Settings />}
          active={path === `${base}/-/settings`}
          {...(onNavigate ? { onNavigate } : {})}
        >
          Org settings
        </NavLink>
        {canConfigureLane(who.data ?? undefined) && who.data?.org === orgSlug ? (
          <NavLink
            to="/$org/-/release-lane"
            params={{ org: orgSlug }}
            icon={<PackageCheck />}
            active={path === `${base}/-/release-lane`}
            {...(onNavigate ? { onNavigate } : {})}
          >
            Release lane
          </NavLink>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="px-2 pb-1 text-xs text-faint">Projects</p>
        {scope.projects === null ? (
          <div className="space-y-1 px-2" aria-hidden="true">
            <div className="skeleton h-6" />
            <div className="skeleton h-6" />
          </div>
        ) : (
          scope.projects.map((p) => (
            <NavLink
              key={p.id}
              to="/$org/$project"
              params={{ org: orgSlug, project: p.slug }}
              icon={<PlayCircle />}
              active={path === `${base}/${p.slug}` || path.startsWith(`${base}/${p.slug}/runs`)}
              {...(onNavigate ? { onNavigate } : {})}
            >
              {p.name}
            </NavLink>
          ))
        )}
      </div>
      {projectSlug ? (
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-xs text-faint">{projectSlug}</p>
          <NavLink
            to="/$org/$project/settings"
            params={{ org: orgSlug, project: projectSlug }}
            icon={<Settings />}
            active={path.endsWith("/settings")}
            {...(onNavigate ? { onNavigate } : {})}
          >
            Settings
          </NavLink>
        </div>
      ) : null}
    </nav>
  );
}

/** The signed-in person's menu: who they are, and sign out (or disconnect from a token). */
function AccountMenu() {
  const session = useSession();
  if (chooseBackend() !== "http") return null;
  const signedIn = isSessionActive();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            signedIn ? `Account${session.login ? `: ${session.login}` : ""}` : "Connection"
          }
        >
          <Avatar src={null} name={session.login ?? "Account"} className="size-6" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {signedIn ? (
          <>
            {session.login ? (
              <DropdownMenuLabel className="font-normal">
                Signed in as {session.login}
              </DropdownMenuLabel>
            ) : null}
            <DropdownMenuItem
              onSelect={() => {
                resetDirectory();
                void signOut();
              }}
            >
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => disconnect()}>Disconnect</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveIndicator() {
  const status = useConnectionStatus();
  const live = status === "live" || status === "polling";
  return (
    <Tooltip
      label={
        status === "live"
          ? "Live: updates stream in as they happen"
          : status === "polling"
            ? "Updates arrive every few seconds"
            : status === "offline"
              ? "Offline: showing the last known state"
              : status === "connecting"
                ? "Connecting"
                : "Reconnecting"
      }
    >
      <span
        role="status"
        className={cn(
          "hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs sm:inline-flex",
          live ? "text-st-success" : "text-st-infra",
        )}
      >
        {live ? (
          <Wifi className="size-3.5" aria-hidden="true" />
        ) : (
          <WifiOff className="size-3.5" aria-hidden="true" />
        )}
        {status === "live"
          ? "Live"
          : status === "polling"
            ? "Polling"
            : status === "offline"
              ? "Offline"
              : "Reconnecting"}
      </span>
    </Tooltip>
  );
}

function Toaster() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "enter pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm shadow-[0_8px_30px_rgb(0_0_0/0.18)]",
            t.tone === "error"
              ? "border-st-failure bg-st-failure-bg text-st-failure"
              : "border-line bg-surface text-foreground",
          )}
        >
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="rounded px-1 text-dim hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const rows: [string, string][] = [
    [`${modKey()} K`, "Open the command palette"],
    ["g then o", "Go to the org overview"],
    ["g then r", "Go to runs"],
    ["g then s", "Go to project settings"],
    ["j / k", "Next or previous run in a list"],
    ["?", "Show this list"],
    ["f", "Log: toggle follow"],
    ["w", "Log: toggle wrap"],
    ["t", "Log: toggle timestamps"],
    ["/", "Log: search"],
    ["n / Shift N", "Log: next or previous match"],
    ["Shift click", "Log: select a line range"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-5">
        <DialogTitle className="text-base font-semibold">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-dim">
          Shortcuts pause while you type in a field.
        </DialogDescription>
        <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd className="px-1.5">{k}</Kbd>
              </dt>
              <dd className="text-dim">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex justify-end">
          <DialogClose asChild>
            <Button variant="secondary" size="sm">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShellInner() {
  const scope = useScope();
  const navigate = useNavigate();
  const { toggle, pref } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useApprovalNotifications();

  useEffect(() => {
    if (scope.orgSlug) rememberOrg(scope.orgSlug);
  }, [scope.orgSlug]);
  useEffect(() => {
    if (scope.orgSlug && scope.projectSlug) rememberProject(scope.orgSlug, scope.projectSlug);
  }, [scope.orgSlug, scope.projectSlug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hotkeys = useMemo(
    () => ({
      "?": () => setHelpOpen(true),
      "g o": () => scope.orgSlug && void navigate({ to: "/$org", params: { org: scope.orgSlug } }),
      "g r": () =>
        scope.orgSlug &&
        scope.projectSlug &&
        void navigate({
          to: "/$org/$project",
          params: { org: scope.orgSlug, project: scope.projectSlug },
        }),
      "g s": () =>
        scope.orgSlug &&
        scope.projectSlug &&
        void navigate({
          to: "/$org/$project/settings",
          params: { org: scope.orgSlug, project: scope.projectSlug },
        }),
    }),
    [navigate, scope.orgSlug, scope.projectSlug],
  );
  useHotkeys(hotkeys);

  const dark =
    typeof document !== "undefined" &&
    (document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1 border-b border-line bg-background/90 px-3 pt-[env(safe-area-inset-top)] backdrop-blur md:px-4">
        <Dialog open={navOpen} onOpenChange={setNavOpen}>
          <Tooltip label="Menu">
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
            >
              <Menu />
            </Button>
          </Tooltip>
          <SheetContent aria-describedby={undefined}>
            <DialogTitle className="sr-only">Navigation</DialogTitle>
            <div className="flex h-12 items-center border-b border-line px-4">
              <Logo />
            </div>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Dialog>
        <Link
          to="/"
          className="mr-1 flex items-center rounded-md px-1 py-1"
          aria-label="Turntable home"
        >
          <Logo />
        </Link>
        <span className="text-faint" aria-hidden="true">
          /
        </span>
        <OrgSwitcher />
        <span className="text-faint" aria-hidden="true">
          /
        </span>
        <ProjectSwitcher />
        <div className="ml-auto flex items-center gap-1">
          <LiveIndicator />
          <Button
            variant="secondary"
            size="sm"
            className="hidden w-52 justify-start gap-2 text-faint sm:inline-flex"
            onClick={() => setPaletteOpen(true)}
            aria-label={`Search or jump to ${modKey()} K`}
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Search />
            <span className="flex-1 text-left">Search or jump to</span>
            <Kbd>{modKey()} K</Kbd>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="sm:hidden"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
          >
            <Search />
          </Button>
          <Tooltip label={dark ? "Switch to light" : "Switch to dark"}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              data-pref={pref}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </Tooltip>
          <NotificationBell />
          <AccountMenu />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {scope.orgSlug ? (
          <aside className="sticky top-12 hidden h-[calc(100dvh-3rem)] w-56 shrink-0 overflow-y-auto border-r border-line md:block">
            <SidebarNav />
          </aside>
        ) : null}
        <main id="main" className="min-w-0 flex-1">
          <IncidentBanner />
          <ApprovalNotifyBanner />
          <Outlet />
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onHelp={() => setHelpOpen(true)}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <Toaster />
    </div>
  );
}

/**
 * The gate (#477). Any logged-out visit ends on the sign-in route (GitHub first, the API token
 * form as a secondary route); a visitor holding a token or a web session gets the app. The
 * fixture backend needs no sign-in.
 */
export function Shell() {
  const auth = useAuth();
  const session = useSession();
  const router = useRouter();
  const loc = useRouterState({ select: (s) => s.location });
  const path = loc.pathname;
  const fixture = chooseBackend() === "fixture";
  const instance = isInstancePath(path);
  const gate = gateFor({
    fixture,
    hasToken: Boolean(auth.token),
    session: session.status,
    path,
    here: `${path}${loc.searchStr}`,
    next: (loc.search as { next?: unknown }).next,
  });

  useEffect(() => {
    if (instance || fixture || auth.token || session.status !== "unknown") return;
    void loadSession();
  }, [instance, fixture, auth.token, session.status]);

  const redirectTo =
    gate.kind !== "redirect"
      ? null
      : gate.next
        ? `${gate.to}?next=${encodeURIComponent(gate.next)}`
        : gate.to;
  useEffect(() => {
    if (!instance && redirectTo !== null) router.history.replace(redirectTo);
  }, [instance, redirectTo, router]);

  // The instance area has its own sign-in: no org session is needed or used there, and an org
  // session does not open it.
  if (instance) return <InstanceShell />;
  if (gate.kind === "screen") return gate.screen === "token" ? <ConnectScreen /> : <SignInScreen />;
  if (gate.kind === "app") return <ShellInner />;
  return <div className="min-h-dvh" aria-busy="true" />;
}
