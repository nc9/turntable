// Per-person notifications (#611): the fixed text of each kind, shared by the bell, the page and
// the browser notice. The text is a template over slugs, a count and a kind. The server's
// `title` (escaped, truncated forge text) is shown on the page as plain text and is NEVER part
// of a browser notification.
import type { AppNotification, NotificationKind } from "@/api/types";

export const KIND_LABELS: Record<NotificationKind, string> = {
  run_failed: "Run failed",
  infra_errors: "Infrastructure errors",
  work_held: "Work held",
  approval_waiting: "Approval waiting",
  checkout_auth_failed: "Checkout authentication failed",
  dogfood_red: "Dogfood red",
  deploy_failed: "Deploy failed",
};

export const KIND_ORDER = Object.keys(KIND_LABELS) as NotificationKind[];

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const part = (s: string): string => s.replace(CONTROL, " ").trim().slice(0, 80);

/** The fixed one-line text of a notification: ids and counts only, no forge text. */
export function noticeTitle(
  n: Pick<AppNotification, "kind" | "org" | "project" | "count">,
): string {
  const where = n.project ? `${part(n.org)}/${part(n.project)}` : part(n.org);
  switch (n.kind) {
    case "run_failed":
      return `Run failed: ${where}`;
    case "infra_errors":
      return n.count > 1
        ? `${n.count} infrastructure errors in ${where}`
        : `Infrastructure error in ${where}`;
    case "work_held":
      return `Work is held in ${where}`;
    case "approval_waiting":
      return `Approval waiting: ${where}`;
    case "checkout_auth_failed":
      return `Checkout authentication failed: ${where}`;
    case "dogfood_red":
      return `Dogfood is red: ${where}`;
    case "deploy_failed":
      return `Deploy failed: ${where}`;
  }
}

export const NOTIFIED_NOTICES_KEY = "tt-notices-notified";
const REMEMBER_MAX = 500;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function ids(storage: StorageLike | null): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(NOTIFIED_NOTICES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Which unread notifications still need a browser notice: those not noticed before in this
 * browser. They are remembered at once, so each id notifies once. Storage failures only mean a
 * repeat.
 */
export function takeFreshNotices(
  items: readonly AppNotification[],
  storage: StorageLike | null,
): AppNotification[] {
  const done = new Set(ids(storage));
  const fresh = items.filter((n) => n.readAt === null && !done.has(n.id));
  if (fresh.length > 0) {
    try {
      storage?.setItem(
        NOTIFIED_NOTICES_KEY,
        JSON.stringify([...done, ...fresh.map((n) => n.id)].slice(-REMEMBER_MAX)),
      );
    } catch {
      // not remembered
    }
  }
  return fresh;
}
