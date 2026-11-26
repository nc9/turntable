import { expect, test } from "bun:test";
import {
  CHUNK_RELOAD_KEY,
  DISMISS_MS,
  claimChunkReload,
  createVersionAwareFetch,
  createVersionWatcher,
  displayVersion,
  isStaleAssetError,
} from "../src/lib/build-version";

const UI = "0.1.0-dev7+594b21af";
const NEW = "0.1.0-dev8+aaaaaaaa";

function healthz(version: string | null) {
  const calls: string[] = [];
  const fetchStub = (async (input: string) => {
    calls.push(input);
    return version === null
      ? new Response("x", { status: 503 })
      : Response.json({ ok: true, version });
  }) as never;
  return { calls, fetchStub };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function make(uiVersion: string, server: string | null, clock = { t: 0 }) {
  const h = healthz(server);
  const w = createVersionWatcher({ uiVersion, now: () => clock.t, fetch: h.fetchStub });
  return { w, h, clock };
}

test("no prompt when the UI version is empty, the header is null or empty, or equal", async () => {
  for (const [ui, v] of [
    ["", NEW],
    [UI, null],
    [UI, ""],
    [UI, UI],
  ] as const) {
    const { w, h } = make(ui, NEW);
    w.observe(v);
    await settle();
    expect(w.pending()).toBeNull();
    expect(h.calls).toEqual([]);
  }
});

test("the prompt is set only after /healthz confirms the difference", async () => {
  const { w, h } = make(UI, NEW);
  w.observe(NEW);
  expect(w.pending()).toBeNull();
  await settle();
  expect(h.calls).toEqual(["/healthz"]);
  expect(w.pending()).toBe(NEW);
});

test("a confirm that agrees with the UI version cancels the prompt", async () => {
  const { w } = make(UI, UI);
  w.observe(NEW);
  await settle();
  expect(w.pending()).toBeNull();
  const down = make(UI, null);
  down.w.observe(NEW);
  await settle();
  expect(down.w.pending()).toBeNull();
});

test("dismiss hides for 30 minutes, then the next differing observation shows it again", async () => {
  const { w, clock } = make(UI, NEW);
  w.observe(NEW);
  await settle();
  w.dismiss();
  expect(w.pending()).toBeNull();
  clock.t = DISMISS_MS - 1;
  w.observe(NEW);
  await settle();
  expect(w.pending()).toBeNull();
  clock.t = DISMISS_MS;
  w.observe(NEW);
  await settle();
  expect(w.pending()).toBe(NEW);
});

test("a different server version re-prompts immediately after a dismissal", async () => {
  const clock = { t: 0 };
  let served = NEW;
  const w = createVersionWatcher({
    uiVersion: UI,
    now: () => clock.t,
    fetch: (async () => Response.json({ version: served })) as never,
  });
  w.observe(NEW);
  await settle();
  w.dismiss();
  served = "0.1.0-dev9+bbbbbbbb";
  w.observe(served);
  await settle();
  expect(w.pending()).toBe(served);
});

test("versionAwareFetch observes the header on 200, 401 and 500", async () => {
  for (const status of [200, 401, 500]) {
    const seen: (string | null)[] = [];
    const f = createVersionAwareFetch(
      (v) => seen.push(v),
      async () => new Response("", { status, headers: { "turntable-version": NEW } }),
    );
    expect((await f("/x")).status).toBe(status);
    expect(seen).toEqual([NEW]);
  }
});

test("the stale-asset matcher accepts the three browser messages only", () => {
  expect(isStaleAssetError("Failed to fetch dynamically imported module: /a.js")).toBe(true);
  expect(isStaleAssetError("error loading dynamically imported module")).toBe(true);
  expect(isStaleAssetError("Importing a module script failed.")).toBe(true);
  expect(isStaleAssetError("TypeError: x is undefined")).toBe(false);
  expect(isStaleAssetError(undefined)).toBe(false);
});

test("the reload guard reloads once, never without storage, and never twice", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  expect(claimChunkReload(storage, "m")).toBe(true);
  expect(data.get(CHUNK_RELOAD_KEY)).toBe("m");
  expect(claimChunkReload(storage, "m")).toBe(false);
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  expect(claimChunkReload(throwing, "m")).toBe(false);
  expect(claimChunkReload(undefined, "m")).toBe(false);
});

test("versions are only ever equal or different: dev10 vs dev9 has no order", async () => {
  const a = "0.1.0-dev10+aaaaaaaa";
  const b = "0.1.0-dev9+bbbbbbbb";
  const { w } = make(a, b);
  w.observe(b);
  await settle();
  expect(w.pending()).toBe(b);
  expect(displayVersion(b)).toBe("0.1.0-dev9");
});
