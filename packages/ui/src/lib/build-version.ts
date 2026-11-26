// Detects that the server is running a different build than the bundle this tab loaded, and
// holds the state the update banner shows. Pure logic: no DOM at import time, and the clock,
// storage and fetch are injectable so `bun test` runs it without a browser.
//
// Versions are compared with `===` only. Semver precedence would put dev10 before dev9, so
// nothing here (or anywhere) decides which version is newer: a version is "different" or not.

/** Inlined at build time (`define` in scripts/build-bundle.ts); empty in a dev build. */
function baked(read: () => string | undefined): string {
  try {
    return read() ?? "";
  } catch {
    return "";
  }
}

export const UI_VERSION: string = baked(() => process.env.TURNTABLE_UI_VERSION);
export const UI_SHA: string = baked(() => process.env.TURNTABLE_UI_SHA);

export const DISMISS_MS = 30 * 60 * 1000;
export const POLL_MS = 5 * 60 * 1000;
export const CHUNK_RELOAD_KEY = "tt-chunk-reload";

/** The version without its build metadata (`+sha8`), for display. */
export const displayVersion = (v: string): string => v.split("+")[0] ?? v;

export type UpdateState = { serverVersion: string | null; dismissedVersion: string | null };

export type WatcherDeps = {
  uiVersion: string;
  now?: () => number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type VersionWatcher = {
  observe(v: string | null): void;
  /** The version to announce, or null when there is nothing to show. */
  pending(): string | null;
  dismiss(): void;
  subscribe(cb: () => void): () => void;
  /** One `/healthz` read, fed to `observe`. Never throws. */
  poll(): Promise<void>;
};

export function createVersionWatcher(deps: WatcherDeps): VersionWatcher {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? ((i: string, n?: RequestInit) => fetch(i, n));
  const listeners = new Set<() => void>();
  let shown: string | null = null;
  let dismissed: { version: string; at: number } | null = null;
  let confirming: string | null = null;

  const emit = (): void => {
    for (const l of listeners) l();
  };

  async function healthzVersion(): Promise<string | null> {
    try {
      const res = await doFetch("/healthz", { cache: "no-store", credentials: "omit" });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === "string" && body.version !== "" ? body.version : null;
    } catch {
      return null;
    }
  }

  const dismissedNow = (v: string): boolean =>
    dismissed !== null && dismissed.version === v && now() - dismissed.at < DISMISS_MS;

  function observe(v: string | null): void {
    if (deps.uiVersion === "" || v === null || v === "" || v === deps.uiVersion) return;
    if (shown === v) return;
    if (dismissedNow(v)) return;
    if (confirming === v) return;
    // Confirm once before prompting: during a rolling deploy an old and a new instance both answer.
    confirming = v;
    void healthzVersion().then((confirmed) => {
      confirming = null;
      if (confirmed === null || confirmed === deps.uiVersion) return;
      if (dismissedNow(confirmed)) return;
      shown = confirmed;
      emit();
    });
  }

  return {
    observe,
    pending: () => (shown !== null && !dismissedNow(shown) ? shown : null),
    dismiss() {
      if (shown === null) return;
      dismissed = { version: shown, at: now() };
      shown = null;
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async poll() {
      observe(await healthzVersion());
    },
  };
}

export const watcher: VersionWatcher = createVersionWatcher({ uiVersion: UI_VERSION });

/** Feed the `Turntable-Version` header of any API response to the watcher. */
export const observeServerVersion = (v: string | null): void => watcher.observe(v);

/** A fetch that reports the server's version header. Injected test fetches stay unobserved. */
export function createVersionAwareFetch(
  observe: (v: string | null) => void,
  inner: (input: string, init?: RequestInit) => Promise<Response> = (i, n) => fetch(i, n),
): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const res = await inner(input, init);
    observe(res.headers.get("turntable-version"));
    return res;
  }) as typeof fetch;
}

export const versionAwareFetch: typeof fetch = createVersionAwareFetch(observeServerVersion);

// ---- stale assets: reload once after a failed dynamic import ----

const CHUNK_ERRORS = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
];

export const isStaleAssetError = (message: unknown): boolean =>
  typeof message === "string" && CHUNK_ERRORS.some((m) => message.includes(m));

/** True when a reload should happen now: the first failure in this tab session, with storage. */
export function claimChunkReload(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  marker: string,
): boolean {
  try {
    if (!storage || storage.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    storage.setItem(CHUNK_RELOAD_KEY, marker);
    return true;
  } catch {
    return false;
  }
}

/** Starts the idle poll and the stale-asset listener. Browser only; returns a stop function. */
export function startVersionWatch(): () => void {
  if (UI_VERSION === "" || typeof window === "undefined") return () => {};
  const tick = (): void => {
    if (document.visibilityState !== "hidden") void watcher.poll();
  };
  const timer = setInterval(tick, POLL_MS);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void watcher.poll();
  };
  const reloadOnce = (message: unknown): void => {
    if (!isStaleAssetError(message)) return;
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = undefined;
    }
    if (claimChunkReload(storage, String(Date.now()))) window.location.reload();
  };
  const onRejection = (e: PromiseRejectionEvent): void =>
    reloadOnce((e.reason as { message?: unknown } | undefined)?.message ?? e.reason);
  const onError = (e: ErrorEvent): void => reloadOnce(e.message);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
