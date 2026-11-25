// Per-person notifications (#611): fixed templates, once-per-id browser notices, opt-in reuse.
import { describe, expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { createNotifier, type NotificationLike } from "../src/lib/approval-notifications";
import { KIND_LABELS, noticeTitle, takeFreshNotices } from "../src/lib/notifications";

const HOSTILE = "<img src=x onerror=alert(1)> MARK-77";
const n = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1",
  kind: "run_failed",
  org: "acme",
  project: "web",
  runId: "r1",
  count: 1,
  title: HOSTILE,
  createdAt: 1,
  readAt: null,
  link: "/acme/web/runs/r1",
  ...over,
});

function store() {
  const m = new Map<string, string>();
  return {
    m,
    s: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    },
  };
}

describe("templates", () => {
  test("every kind has a fixed text with no forge text in it", () => {
    for (const kind of Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]) {
      const t = noticeTitle(n({ kind }));
      expect(t).toContain("acme");
      expect(t).not.toContain("MARK-77");
    }
    expect(noticeTitle(n({ kind: "infra_errors", count: 12 }))).toBe(
      "12 infrastructure errors in acme/web",
    );
    expect(noticeTitle(n({ kind: "work_held", project: null }))).toBe("Work is held in acme");
  });
  test("control and bidi characters in a slug are stripped", () => {
    expect(noticeTitle(n({ org: "a‮b\u0007c" }))).not.toMatch(/[‮\u0007]/);
  });
});

describe("takeFreshNotices", () => {
  test("each id is noticed once, read ones never", () => {
    const { s } = store();
    expect(takeFreshNotices([n(), n({ id: "n2", readAt: 5 })], s).map((x) => x.id)).toEqual(["n1"]);
    expect(takeFreshNotices([n()], s)).toEqual([]);
  });
});

describe("browser notice", () => {
  const make = (permission: "default" | "granted") => {
    const shown: { title: string; click: () => void }[] = [];
    const N = function (this: unknown, title: string) {
      const inst = { onclick: null as null | (() => void), close() {} };
      shown.push({ title, click: () => inst.onclick?.() });
      return inst;
    } as unknown as NotificationLike;
    Object.defineProperty(N, "permission", { get: () => permission });
    const opened: string[] = [];
    const notifier = createNotifier({
      notification: N,
      storage: store().s,
      open: (l) => opened.push(l),
    });
    return { notifier, shown, opened };
  };
  test("shows nothing without permission; with it, a click opens the run", () => {
    const off = make("default");
    off.notifier.notice("x", "t", "/acme/web/runs/r1");
    expect(off.shown).toEqual([]);
    const on = make("granted");
    on.notifier.notice(noticeTitle(n()), "t", "/acme/web/runs/r1");
    expect(on.shown.map((x) => x.title)).toEqual(["Run failed: acme/web"]);
    on.shown[0]!.click();
    expect(on.opened).toEqual(["/acme/web/runs/r1"]);
  });
  test("an off-origin link is not opened", () => {
    const on = make("granted");
    on.notifier.notice("x", "t", "https://evil.example/");
    on.shown[0]!.click();
    expect(on.opened).toEqual(["/"]);
  });
});
