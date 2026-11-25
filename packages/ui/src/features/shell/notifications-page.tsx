import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { getBackend } from "@/api";
import type { NotificationKind } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/format";
import { KIND_LABELS, KIND_ORDER, noticeTitle } from "@/lib/notifications";
import { useAsync } from "@/lib/use-async";
import { ApprovalNotifyToggle } from "./approval-notifications";
import { NOTIFICATIONS_CHANGED } from "./notification-bell";
import { useScope } from "./scope";

const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

/** The person's notifications across their orgs: filter by kind or unread, mark read. */
export function NotificationsPage() {
  const [unread, setUnread] = useState(false);
  const [kind, setKind] = useState<NotificationKind | "">("");
  const q = useAsync(
    () =>
      getBackend().api.myNotifications({
        unread,
        ...(kind ? { kinds: [kind] } : {}),
        limit: 50,
      }),
    [unread, kind],
  );
  const ack = async (ids?: string[]) => {
    const org = q.data?.notifications[0]?.org;
    await getBackend().api.notificationsAck({ ...(ids ? { ids } : {}), ...(org ? { org } : {}) });
    q.reload();
    changed();
  };
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Notifications</h1>
        <Link to="/notifications/settings" className="ml-auto text-sm text-dim underline">
          Preferences
        </Link>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          Kind
          <select
            className="rounded-md border border-line bg-background px-2 py-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as NotificationKind | "")}
          >
            <option value="">All</option>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />
          Unread only
        </label>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={!q.data || q.data.unreadCount === 0}
          onClick={() => void ack()}
        >
          Mark all read
        </Button>
      </div>
      {q.error ? (
        <ErrorState title="Could not load notifications" message={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Skeleton className="mt-4 h-24 w-full" />
      ) : q.data.notifications.length === 0 ? (
        <p className="mt-6 text-sm text-dim">Nothing here.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {q.data.notifications.map((n) => (
            <li key={n.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3 text-sm">
              <span
                className={n.readAt === null ? "font-medium" : "text-dim"}
                aria-label={n.readAt === null ? "Unread" : undefined}
              >
                <Link to={n.link} onClick={() => n.readAt === null && void ack([n.id])}>
                  {noticeTitle(n)}
                </Link>
              </span>
              {/* Escaped, truncated forge text: rendered as plain text by React, never as markup. */}
              {n.title ? <span className="min-w-0 truncate text-dim">{n.title}</span> : null}
              <span className="tabular ml-auto text-dim">{formatRelative(n.createdAt)}</span>
              {n.readAt === null ? (
                <Button size="sm" variant="ghost" onClick={() => void ack([n.id])}>
                  Mark read
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Per kind: on or off everywhere, plus this browser's opt-in. */
export function NotificationPrefsPage() {
  const scope = useScope();
  const q = useAsync(() => getBackend().api.getNotificationPrefs(), [scope.orgSlug]);
  const set = async (kind: NotificationKind, enabled: boolean | null) => {
    await getBackend().api.setNotificationPref({ kind, enabled });
    q.reload();
  };
  const explicit = (k: NotificationKind) =>
    q.data?.prefs.find((p) => p.kind === k && p.org === null && p.project === null)?.enabled;
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-lg font-semibold">Notification preferences</h1>
      <p className="mt-1 text-sm text-dim">
        Choose what you are told about, in every org you belong to. Pull request failures reach only
        the person who authored them.
      </p>
      {q.error ? (
        <ErrorState title="Could not load preferences" message={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Skeleton className="mt-4 h-24 w-full" />
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {q.data.defaults
            .filter((d) => !d.operatorOnly)
            .map((d) => (
              <li key={d.kind} className="flex items-center gap-3 px-4 py-3 text-sm">
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={explicit(d.kind) ?? d.enabled}
                    onChange={(e) => void set(d.kind, e.target.checked)}
                  />
                  {KIND_LABELS[d.kind]}
                </label>
                {explicit(d.kind) !== undefined ? (
                  <Button size="sm" variant="ghost" onClick={() => void set(d.kind, null)}>
                    Reset
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      )}
      <ApprovalNotifyToggle />
    </div>
  );
}
