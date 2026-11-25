// Browser notifications for approvals waiting on the signed-in person (#545).
//
// What this module guarantees, in code:
// - the permission prompt is only ever opened by `requestPermission`, which only the banner and
//   the settings toggle call, from a click. Nothing here asks on load;
// - a notification's text comes from FIXED templates over the fields of `my_pending_approvals`
//   (org and project slugs, the environment name, a count). No repository text can reach it, and
//   the server returns none;
// - a notification never approves anything: clicking it focuses the tab and opens the item's
//   own approval screen, where the approval still needs the passkey;
// - each item id notifies once, remembered per browser (localStorage, every access guarded).
import type { PendingApproval } from "@/api/types";
import { sanitizeNext } from "./session";

export const PREF_KEY = "tt-approval-notify";
export const BANNER_KEY = "tt-approval-notify-banner";
export const NOTIFIED_KEY = "tt-approval-notified";
export const EXPIRY_NOTIFIED_KEY = "tt-approval-expiry-notified";
/** A second notice goes out once an item is this close to its expiry. */
export const EXPIRY_NOTICE_MS = 10 * 60_000;
const REMEMBER_MAX = 500;
const BASE_TITLE = "Turntable";

export type NotifyPref = "on" | "off";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** The slice of the Notification API used here, so a test can stand in for it. */
export type NotificationLike = {
  new (title: string, options?: { body?: string; tag?: string }): NotificationInstance;
  permission: "default" | "granted" | "denied";
  requestPermission(): Promise<"default" | "granted" | "denied">;
};
export type NotificationInstance = {
  onclick: ((this: unknown, ev: unknown) => unknown) | null;
  close(): void;
};

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage: StorageLike | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // storage unavailable or full: the choice just is not remembered
  }
}

function readIds(storage: StorageLike | null, key: string): string[] {
  try {
    const v: unknown = JSON.parse(read(storage, key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A value from a slug or environment name, made safe for a one-line notification title. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const part = (s: string): string => s.replace(CONTROL, " ").trim().slice(0, 80);

/** The fixed plain-text title of an item's notification. */
export function titleFor(item: PendingApproval): string {
  const where = `${part(item.org)}/${part(item.project)}`;
  const env = item.environment !== undefined ? ` ${part(item.environment)}` : "";
  switch (item.kind) {
    case "release_approval":
      return `Release approval waiting: ${where}${env}`;
    case "environment_approval":
      return `Environment approval waiting: ${where}${env}`;
    case "untrusted_run_approval":
      return `Run approval waiting: ${where}`;
    case "enrolment_approval":
      return `Key enrolment approval waiting: ${part(item.org)}`;
    case "key_policy_approval":
      return `Key policy approval waiting: ${part(item.org)}`;
  }
}

/** The fixed title of the second notice, sent when an item is close to expiring. */
export const expiryTitleFor = (item: PendingApproval): string => `Expiring soon. ${titleFor(item)}`;

export const summaryTitle = (n: number): string =>
  `${n} ${n === 1 ? "approval" : "approvals"} waiting`;

/** The tab title with the pending count: "(2) Turntable". */
export const titleWithCount = (n: number): string => (n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE);

export function setTabTitle(doc: { title: string }, n: number): void {
  doc.title = titleWithCount(n);
}

export type Notifier = {
  supported(): boolean;
  permission(): "default" | "granted" | "denied" | "unsupported";
  /** The remembered choice for this browser, if any. */
  pref(): NotifyPref | null;
  /** Permission granted and not switched off here. */
  active(): boolean;
  bannerVisible(): boolean;
  dismissBanner(): void;
  /** Opens the browser prompt. Call it only from a click. */
  requestPermission(): Promise<"default" | "granted" | "denied" | "unsupported">;
  setPref(p: NotifyPref): void;
  /** The first answer after a page load: one summary for what is already pending. */
  onLoad(items: readonly PendingApproval[], now: number): void;
  /** Any later answer: a notice per item not notified before, and expiry notices. */
  onChange(items: readonly PendingApproval[], now: number): void;
  /** A browser notice with fixed text (#611); shown only when notifications are on here. */
  notice(title: string, tag: string, link: string): void;
  /** Ms until the next expiry notice is due, or null when none is pending. */
  nextExpiryDelay(items: readonly PendingApproval[], now: number): number | null;
};

export type NotifierDeps = {
  notification?: NotificationLike | undefined;
  storage?: StorageLike | null | undefined;
  /** Focus the tab and open a route. Called from a notification click. */
  open(link: string): void;
};

export function createNotifier(deps: NotifierDeps): Notifier {
  const N: NotificationLike | undefined =
    "notification" in deps
      ? deps.notification
      : typeof Notification === "undefined"
        ? undefined
        : (Notification as unknown as NotificationLike);
  const storage = "storage" in deps ? (deps.storage ?? null) : browserStorage();

  const remember = (key: string, ids: readonly string[]) =>
    write(storage, key, JSON.stringify(ids.slice(-REMEMBER_MAX)));

  const show = (title: string, tag: string, link: string | null) => {
    if (!N) return;
    try {
      const n = new N(title, { tag });
      n.onclick = () => {
        // Only a same-origin route of the app is opened: anything else is ignored.
        const to = link === null ? undefined : sanitizeNext(link);
        deps.open(to ?? "/");
        n.close();
      };
    } catch {
      // some browsers throw for a page notification: nothing more to do
    }
  };

  const active = (): boolean =>
    !!N && N.permission === "granted" && read(storage, PREF_KEY) !== "off";

  // Ids already notified, kept only while the item is still pending (a resolved item never
  // returns), so the stored list stays small.
  const settle = (items: readonly PendingApproval[]) => {
    const pending = new Set(items.map((i) => i.id));
    remember(
      NOTIFIED_KEY,
      readIds(storage, NOTIFIED_KEY).filter((id) => pending.has(id)),
    );
    remember(
      EXPIRY_NOTIFIED_KEY,
      readIds(storage, EXPIRY_NOTIFIED_KEY).filter((id) => pending.has(id)),
    );
  };

  const expiring = (items: readonly PendingApproval[], now: number): PendingApproval[] => {
    const done = new Set(readIds(storage, EXPIRY_NOTIFIED_KEY));
    return items.filter(
      (i) =>
        i.expiresAt !== undefined &&
        i.expiresAt > now &&
        i.expiresAt - now <= EXPIRY_NOTICE_MS &&
        !done.has(i.id),
    );
  };

  const expiryNotices = (items: readonly PendingApproval[], now: number) => {
    const due = expiring(items, now);
    if (due.length === 0) return;
    remember(EXPIRY_NOTIFIED_KEY, [
      ...readIds(storage, EXPIRY_NOTIFIED_KEY),
      ...due.map((i) => i.id),
    ]);
    for (const i of due) show(expiryTitleFor(i), `tt-approval-expiry-${i.id}`, i.link);
  };

  return {
    notice(title, tag, link) {
      if (active()) show(title, tag, link);
    },
    supported: () => !!N,
    permission: () => (N ? N.permission : "unsupported"),
    pref: () => {
      const v = read(storage, PREF_KEY);
      return v === "on" || v === "off" ? v : null;
    },
    active,
    bannerVisible: () =>
      !!N && N.permission === "default" && read(storage, BANNER_KEY) !== "dismissed",
    dismissBanner: () => write(storage, BANNER_KEY, "dismissed"),
    async requestPermission() {
      if (!N) return "unsupported";
      let result: "default" | "granted" | "denied" = N.permission;
      try {
        result = await N.requestPermission();
      } catch {
        // an old browser that only takes a callback, or a blocked prompt: keep what we had
      }
      write(storage, PREF_KEY, result === "granted" ? "on" : "off");
      return result;
    },
    setPref: (p) => write(storage, PREF_KEY, p),
    onLoad(items, now) {
      if (!active()) return;
      const done = new Set(readIds(storage, NOTIFIED_KEY));
      const fresh = items.filter((i) => !done.has(i.id));
      settle(items);
      if (fresh.length > 0) {
        remember(NOTIFIED_KEY, [...readIds(storage, NOTIFIED_KEY), ...fresh.map((i) => i.id)]);
        // One summary, never one per item; it opens the first item's screen.
        show(summaryTitle(fresh.length), "tt-approval-summary", fresh[0]!.link);
      }
      expiryNotices(items, now);
    },
    onChange(items, now) {
      if (!active()) return;
      const done = new Set(readIds(storage, NOTIFIED_KEY));
      const fresh = items.filter((i) => !done.has(i.id));
      settle(items);
      if (fresh.length > 0)
        remember(NOTIFIED_KEY, [...readIds(storage, NOTIFIED_KEY), ...fresh.map((i) => i.id)]);
      for (const i of fresh) show(titleFor(i), `tt-approval-${i.id}`, i.link);
      expiryNotices(items, now);
    },
    nextExpiryDelay(items, now) {
      const done = new Set(readIds(storage, EXPIRY_NOTIFIED_KEY));
      let best: number | null = null;
      for (const i of items) {
        if (i.expiresAt === undefined || done.has(i.id) || i.expiresAt <= now) continue;
        const wait = Math.max(0, i.expiresAt - EXPIRY_NOTICE_MS - now);
        if (best === null || wait < best) best = wait;
      }
      return best;
    },
  };
}
