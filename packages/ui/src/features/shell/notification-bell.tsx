import { Bell } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { isSessionActive } from "@/lib/session";
import { noticeTitle, takeFreshNotices } from "@/lib/notifications";
import { useNotifier } from "./approval-notifications";

const POLL_VISIBLE_MS = 30_000;
const POLL_HIDDEN_MS = 120_000;

/** Tell other mounted views (the page) that something was read, so they refetch. */
export const NOTIFICATIONS_CHANGED = "tt-notifications-changed";

/**
 * The bell with the unread count. Polls `my_notifications` (30 s visible, 120 s hidden, as the
 * approval inbox does), and raises a browser notice, with fixed text, for each new unread one
 * when this browser opted in (the same opt-in as approvals). It never asks for permission.
 * A server that refuses the op (a token session, an older server) removes the bell quietly.
 */
export function NotificationBell() {
  const notifier = useNotifier();
  const [count, setCount] = useState<number | null>(null);
  const first = useRef(true);
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    try {
      const page = await getBackend().api.myNotifications({ unread: true, limit: 20 });
      setCount(page.unreadCount);
      const fresh = takeFreshNotices(
        page.notifications,
        typeof localStorage === "undefined" ? null : localStorage,
      );
      if (first.current) {
        first.current = false;
        // After a page load one summary, never a burst.
        if (fresh.length > 0)
          notifier.notice(
            fresh.length === 1 ? noticeTitle(fresh[0]!) : `${fresh.length} new notifications`,
            "tt-notices-summary",
            fresh[0]!.link,
          );
      } else {
        for (const n of fresh) notifier.notice(noticeTitle(n), `tt-notice-${n.id}`, n.link);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "forbidden" || code === "not_found" || code === "unauthenticated") {
        stopped.current = true;
        setCount(null);
      }
    }
  }, [notifier]);

  useEffect(() => {
    if (!isSessionActive()) return;
    void refresh();
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
    const visible = () => (document.visibilityState === "visible" ? now() : schedule());
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", now);
    window.addEventListener(NOTIFICATIONS_CHANGED, now);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", now);
      window.removeEventListener(NOTIFICATIONS_CHANGED, now);
      if (poll) clearTimeout(poll);
    };
  }, [refresh]);

  if (!isSessionActive() || count === null) return null;
  const label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  return (
    <Tooltip label="Notifications">
      <Button variant="ghost" size="icon-sm" className="relative" aria-label={label} asChild>
        <Link to="/notifications">
          <Bell />
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-st-failure px-1 text-center text-[10px] font-medium leading-4 text-white"
            >
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </Link>
      </Button>
    </Tooltip>
  );
}
