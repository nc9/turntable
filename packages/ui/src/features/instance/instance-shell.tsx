import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getInstanceApi, type InstanceWhoami } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { disconnectInstance, useInstanceAuth } from "@/lib/instance-auth";
import { NetworkStatusBar } from "./network-status";
import { InstanceSignIn } from "./sign-in";
import { RotatedNotice } from "./rotated-notice";

export const INSTANCE_BASE = "/-/instance";

/** Whether a path belongs to the instance area, which has its own shell and its own sign-in. */
export const isInstancePath = (path: string): boolean =>
  path === INSTANCE_BASE || path.startsWith(`${INSTANCE_BASE}/`);

const SECTIONS = [
  { to: "/-/instance/settings", label: "Settings" },
  { to: "/-/instance/quotas", label: "Orgs and quotas" },
  { to: "/-/instance/projects", label: "Projects" },
  { to: "/-/instance/backups", label: "Backups" },
  { to: "/-/instance/token", label: "Token" },
] as const;

function Who() {
  const [who, setWho] = useState<InstanceWhoami | null>(null);
  useEffect(() => {
    let live = true;
    getInstanceApi()
      .whoami()
      .then((w) => live && setWho(w))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return who ? (
    <span className="truncate text-xs text-dim" title={who.id}>
      {who.name}
    </span>
  ) : null;
}

/**
 * The instance-administrator area. It renders instead of the org shell, so none of the org
 * session, the org client or the realtime socket is involved: only the `tti_` token is.
 */
export function InstanceShell() {
  const auth = useInstanceAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (auth.rotated) return <RotatedNotice secret={auth.rotated} />;
  if (!auth.token) return <InstanceSignIn />;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-background/90 px-4 backdrop-blur">
        <span className="rounded-full border border-st-approval/40 bg-st-approval-bg px-2 py-0.5 font-mono text-[11px] text-st-approval">
          instance administrator
        </span>
        <Who />
        <nav aria-label="Instance" className="ml-2 flex flex-wrap gap-1">
          {SECTIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              aria-current={path === s.to ? "page" : undefined}
              className="rounded-md px-2 py-1 text-[13px] text-dim hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => disconnectInstance()}>
          Sign out
        </Button>
      </header>
      <NetworkStatusBar />
      <main id="main" className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
