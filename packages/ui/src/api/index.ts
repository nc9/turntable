import type { TurntableApi } from "./client";
import { createFixture, type Fixture } from "./fixture/adapter";
import { createHttpApi } from "./http-adapter";
import { createPollingRealtime } from "./polling-realtime";
import type { Realtime } from "./realtime";
import { disconnect, getOrg, getToken } from "@/lib/auth";

export type BackendKind = "http" | "fixture";
export type Backend = {
  kind: BackendKind;
  api: TurntableApi;
  realtime: Realtime;
  fixture: Fixture | null;
};

let backend: Backend | null = null;

/**
 * Which backend to use: `?backend=fixture|http` (remembered for the tab), else the build default
 * (`TURNTABLE_UI_BACKEND`, set by `bun run dev` to fixture), else the real API on the same origin.
 */
/** Inlined at build time (bunfig for the dev server, `define` for the bundle); absent otherwise. */
function buildDefault(): string {
  try {
    return process.env.TURNTABLE_UI_BACKEND ?? "";
  } catch {
    return "";
  }
}

export function chooseBackend(): BackendKind {
  try {
    const q = new URLSearchParams(window.location.search).get("backend");
    if (q === "fixture" || q === "http") {
      sessionStorage.setItem("tt-backend", q);
      return q;
    }
    const stored = sessionStorage.getItem("tt-backend");
    if (stored === "fixture" || stored === "http") return stored;
  } catch {
    // no storage or no window: fall through to the default
  }
  return buildDefault() === "fixture" ? "fixture" : "http";
}

export function getBackend(): Backend {
  if (!backend) {
    if (chooseBackend() === "fixture") {
      const fixture = createFixture();
      backend = { kind: "fixture", api: fixture.api, realtime: fixture.realtime, fixture };
    } else {
      const api = createHttpApi({
        org: getOrg,
        token: getToken,
        onUnauthenticated: () => disconnect("The server did not accept your token. Connect again."),
      });
      // TODO(#30): swap in the WebSocket adapter; polling stays as the fallback transport.
      backend = { kind: "http", api, realtime: createPollingRealtime(api), fixture: null };
    }
  }
  return backend;
}
