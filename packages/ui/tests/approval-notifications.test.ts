import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHttpApi } from "../src/api/http-adapter";
import type { PendingApproval } from "../src/api/types";
import {
  createNotifier,
  EXPIRY_NOTICE_MS,
  type NotificationLike,
  titleFor,
  titleWithCount,
  setTabTitle,
} from "../src/lib/approval-notifications";

const NOW = 1_800_000_000_000;
const MARK = "MARK-5d21c0aa";

type Shown = { title: string; tag: string | undefined; click: () => void };

function harness(
  permission: "default" | "granted" | "denied" = "granted",
  storage = new Map<string, string>(),
) {
  const shown: Shown[] = [];
  const state = { prompts: 0, permission };
  const N = function (this: unknown, title: string, options?: { tag?: string }) {
    const inst = { onclick: null as null | (() => void), close() {} };
    shown.push({ title, tag: options?.tag, click: () => inst.onclick?.() });
    return inst;
  } as unknown as NotificationLike;
  Object.defineProperty(N, "permission", { get: () => state.permission });
  (N as { requestPermission: () => Promise<string> }).requestPermission = async () => {
    state.prompts++;
    state.permission = "granted";
    return "granted";
  };
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  };
  const opened: string[] = [];
  const notifier = createNotifier({ notification: N, storage: store, open: (l) => opened.push(l) });
  return { notifier, shown, state, storage, opened };
}

const item = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "run1:staging",
  kind: "environment_approval",
  org: "acme",
  project: "web",
  environment: "staging",
  createdAt: NOW,
  link: "/acme/web/runs/run1/approve?environment=staging",
  ...over,
});

describe("permission", () => {
  test("is never requested on load or on a change; only requestPermission asks", async () => {
    const h = harness("default");
    expect(h.notifier.bannerVisible()).toBe(true);
    h.notifier.onLoad([item()], NOW);
    h.notifier.onChange([item(), item({ id: "b" })], NOW);
    expect(h.state.prompts).toBe(0);
    expect(h.shown).toEqual([]); // not granted: nothing is shown
    await h.notifier.requestPermission(); // the banner's click
    expect(h.state.prompts).toBe(1);
    expect(h.notifier.pref()).toBe("on");
    expect(h.notifier.bannerVisible()).toBe(false);
  });

  test("the banner stays dismissed, and a switched-off browser shows nothing", () => {
    const h = harness("default");
    h.notifier.dismissBanner();
    expect(harness("default", h.storage).notifier.bannerVisible()).toBe(false);
    const off = harness("granted");
    off.notifier.setPref("off");
    off.notifier.onChange([item()], NOW);
    expect(off.shown).toEqual([]);
  });

  test("only the banner and the toggle call requestPermission, and only the library touches Notification", async () => {
    const src = join(import.meta.dir, "../src");
    const hits: string[] = [];
    for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync(src)) {
      const text = await Bun.file(join(src, f)).text();
      if (/Notification\.requestPermission|\.requestPermission\(/.test(text)) hits.push(f);
    }
    expect(hits.toSorted()).toEqual([
      "features/shell/approval-notifications.tsx",
      "lib/approval-notifications.ts",
    ]);
    const lib = await Bun.file(join(src, "features/shell/approval-notifications.tsx")).text();
    // Each call sits in a click or change handler, never in an effect.
    const effects = lib.match(/useEffect\([\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) expect(e).not.toContain("requestPermission");
  });
});

describe("notices", () => {
  test("one summary on load, for what is pending and not yet notified", () => {
    const h = harness();
    h.notifier.onLoad([item(), item({ id: "b" }), item({ id: "c" })], NOW);
    expect(h.shown.map((s) => s.title)).toEqual(["3 approvals waiting"]);
  });

  test("a new item notifies with a fixed template, once; a reload never repeats it", () => {
    const h = harness();
    h.notifier.onLoad([item()], NOW);
    const release = item({ id: "r:release", kind: "release_approval", environment: "release" });
    h.notifier.onChange([item(), release], NOW);
    h.notifier.onChange([item(), release], NOW);
    expect(h.shown.map((s) => s.title)).toEqual([
      "1 approval waiting",
      "Release approval waiting: acme/web release",
    ]);
    // A reload: a fresh notifier over the same storage.
    const again = harness("granted", h.storage);
    again.notifier.onLoad([item(), release], NOW);
    again.notifier.onChange([item(), release], NOW);
    expect(again.shown).toEqual([]);
  });

  test("templates", () => {
    expect(titleFor(item())).toBe("Environment approval waiting: acme/web staging");
    expect(
      titleFor(item({ kind: "untrusted_run_approval", environment: undefined as never })),
    ).toBe("Run approval waiting: acme/web");
  });

  test("a second notice within ten minutes of expiry, once", () => {
    const h = harness();
    const e = item({
      id: "enrol1",
      kind: "enrolment_approval",
      project: "-",
      expiresAt: NOW + 3 * EXPIRY_NOTICE_MS,
    });
    h.notifier.onChange([e], NOW);
    expect(h.shown).toHaveLength(1);
    expect(h.notifier.nextExpiryDelay([e], NOW)).toBe(2 * EXPIRY_NOTICE_MS);
    h.notifier.onChange([e], NOW + 2 * EXPIRY_NOTICE_MS + 1);
    h.notifier.onChange([e], NOW + 2 * EXPIRY_NOTICE_MS + 2);
    expect(h.shown.map((s) => s.title)).toEqual([
      "Key enrolment approval waiting: acme",
      "Expiring soon. Key enrolment approval waiting: acme",
    ]);
  });

  test("clicking opens the item's own link, and a link off the app is not followed", () => {
    const h = harness();
    h.notifier.onChange([item(), item({ id: "evil", link: "https://evil.example/x" })], NOW);
    h.shown[0]!.click();
    h.shown[1]!.click();
    expect(h.opened).toEqual(["/acme/web/runs/run1/approve?environment=staging", "/"]);
  });
});

describe("no repository text", () => {
  test("the adapter keeps only the op's fields, so a notification cannot carry anything else", async () => {
    const wire = {
      items: [
        {
          id: "run1:staging",
          kind: "environment_approval",
          org: "acme",
          project: "web",
          environment: "staging",
          created_at: "2027-01-01T00:00:00.000Z",
          link: "/acme/web/runs/run1/approve?environment=staging",
          title: `${MARK} PR title`,
          job: `${MARK} job`,
        },
      ],
    };
    const api = createHttpApi({
      org: () => "acme",
      token: () => null,
      session: () => true,
      fetch: async () =>
        new Response(JSON.stringify(wire), { headers: { "content-type": "application/json" } }),
    } as never);
    const items = await api.myPendingApprovals();
    expect(JSON.stringify(items)).not.toContain(MARK);
    const h = harness();
    h.notifier.onLoad(items, NOW);
    h.notifier.onChange(items, NOW);
    for (const s of h.shown) expect(s.title).not.toContain(MARK);
  });

  test("control characters and bidi marks are stripped from the pieces", () => {
    const t = titleFor(item({ environment: "st\naging‮" }));
    expect(t).toBe("Environment approval waiting: acme/web st aging");
  });
});

describe("tab title", () => {
  test("shows the pending count", () => {
    expect(titleWithCount(0)).toBe("Turntable");
    expect(titleWithCount(2)).toBe("(2) Turntable");
    const doc = { title: "Turntable" };
    setTabTitle(doc, 2);
    expect(doc.title).toBe("(2) Turntable");
    setTabTitle(doc, 0);
    expect(doc.title).toBe("Turntable");
  });
});
