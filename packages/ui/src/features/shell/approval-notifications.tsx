import { Bell } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "@/api";
import type { PendingApproval } from "@/api/types";
import { Button } from "@/components/ui/button";
import { createNotifier, type Notifier, setTabTitle } from "@/lib/approval-notifications";
import { isSessionActive } from "@/lib/session";
import { useScope } from "./scope";

/** One notifier for the page: its state lives in localStorage, so a second copy would agree. */
let shared: Notifier | null = null;
export function useNotifier(): Notifier {
  const router = useRouter();
  const open = useCallback(
    (link: string) => {
      try {
        window.focus();
      } catch {
        // not allowed to focus: still open the screen
      }
      router.history.push(link);
    },
    [router],
  );
  const openRef = useRef(open);
  openRef.current = open;
  shared ??= createNotifier({ open: (l) => openRef.current(l) });
  return shared;
}

const POLL_VISIBLE_MS = 30_000;
const POLL_HIDDEN_MS = 120_000;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/** Re-renders when the permission or the remembered choice changes. */
export function useNotifyState(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return n;
}

/**
 * Keeps the tab title count and the notifications in step with `my_pending_approvals`: fetched
 * once on load, again on a live change of the org's runs or when the tab comes back, and once
 * more when an item gets within ten minutes of expiring. A server that refuses the op (a token
 * session, or an older server) turns this off quietly. It never asks for permission.
 */
export function useApprovalNotifications(): void {
  const notifier = useNotifier();
  const first = useRef(true);
  const stopped = useRef(false);
  const items = useRef<PendingApproval[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const orgId = useScope().org?.id ?? null;

  const apply = useCallback(
    (next: PendingApproval[]) => {
      items.current = next;
      setTabTitle(document, next.length);
      const now = Date.now();
      if (first.current) {
        first.current = false;
        notifier.onLoad(next, now);
      } else notifier.onChange(next, now);
      if (timer.current) clearTimeout(timer.current);
      const wait = notifier.nextExpiryDelay(next, now);
      if (wait !== null)
        timer.current = setTimeout(() => notifier.onChange(items.current, Date.now()), wait + 50);
    },
    [notifier],
  );

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    try {
      apply(await getBackend().api.myPendingApprovals());
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Refused or unknown to this server: not a person's session. Anything else may pass.
      if (code === "forbidden" || code === "not_found" || code === "unauthenticated") {
        stopped.current = true;
        setTabTitle(document, 0);
      }
    }
  }, [apply]);

  useEffect(() => {
    if (!isSessionActive()) return;
    void refresh();
    // A session cannot open the realtime socket, so the inbox is polled: every 30 s while the tab
    // is visible, every 120 s while it is hidden, and at once when the tab regains focus.
    let poll: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (poll) clearTimeout(poll);
      poll = setTimeout(
        () => {
          void refresh();
          schedule();
        },
        document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS,
      );
    };
    schedule();
    const now = () => {
      void refresh();
      schedule();
    };
    const later = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void refresh(), 800);
    };
    const visible = () => {
      if (document.visibilityState === "visible") now();
      else schedule();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", now);
    // A permission just granted from the banner or the settings toggle: say what is waiting.
    const granted = () => {
      first.current = true;
      later();
    };
    listeners.add(granted);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", now);
      listeners.delete(granted);
      if (poll) clearTimeout(poll);
      if (timer.current) clearTimeout(timer.current);
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [refresh]);

  // A live change of the org's runs and jobs (a new gated job, an approval) refetches.
  useEffect(() => {
    if (!isSessionActive()) return;
    const id = orgId ?? "";
    return getBackend().realtime.subscribe({ kind: "org", orgId: id }, {}, (m) => {
      if (m.type !== "change") return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void refresh(), 800);
    });
  }, [orgId, refresh]);
}

/** The banner that asks, once and only on a click, to be allowed to notify. */
export function ApprovalNotifyBanner() {
  const notifier = useNotifier();
  const tick = useNotifyState();
  const [hidden, setHidden] = useState(false);
  const show = useMemo(
    () => isSessionActive() && notifier.bannerVisible(),
    // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-reads the stored choice
    [notifier, tick, hidden],
  );
  if (!show) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-muted px-4 py-2 text-sm"
    >
      <Bell className="size-4 shrink-0 text-dim" aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-64 text-foreground">
        Get notified when something needs your approval
      </p>
      <Button
        size="sm"
        onClick={() => {
          void notifier.requestPermission().then(() => {
            setHidden(true);
            changed();
          });
        }}
      >
        Turn on notifications
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          notifier.dismissBanner();
          setHidden(true);
        }}
      >
        Not now
      </Button>
    </div>
  );
}

/** The per-browser switch, for the settings page. */
export function ApprovalNotifyToggle() {
  const notifier = useNotifier();
  useNotifyState();
  const permission = notifier.permission();
  const on = notifier.active();
  const [, force] = useState(0);
  if (!isSessionActive()) return null;
  return (
    <section aria-labelledby="notify-h" className="mt-8">
      <h2 id="notify-h" className="text-base font-semibold tracking-tight">
        This browser: approval notifications
      </h2>
      <p className="mt-0.5 text-sm text-dim">
        This browser shows a notification when an approval is waiting on you. A notification only
        opens the screen; approving still needs your passkey. The choice is kept per browser.
      </p>
      {permission === "unsupported" ? (
        <p className="mt-3 text-sm text-dim">This browser does not support notifications.</p>
      ) : permission === "denied" ? (
        <p className="mt-3 text-sm text-dim">
          Notifications are blocked for this site. Allow them in the browser's site settings to turn
          them on.
        </p>
      ) : (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              if (e.target.checked) {
                if (permission === "granted") notifier.setPref("on");
                else void notifier.requestPermission().then(changed);
              } else notifier.setPref("off");
              force((x) => x + 1);
              changed();
            }}
          />
          Notify me in this browser about approvals waiting on me
        </label>
      )}
    </section>
  );
}
