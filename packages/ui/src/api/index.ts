import type { TurntableApi } from "./client";
import type { Realtime } from "./realtime";
import { createFixture, type Fixture } from "./fixture/adapter";

export type Backend = { api: TurntableApi; realtime: Realtime; fixture: Fixture | null };

let backend: Backend | null = null;

/**
 * The UI runs on the fixture adapter until the REST API (#24) and WebSocket transport (#30)
 * exist. Switching is one line here: build the HTTP and WS adapters from ws-adapter.ts.
 */
export function getBackend(): Backend {
  if (!backend) {
    const fixture = createFixture();
    backend = { api: fixture.api, realtime: fixture.realtime, fixture };
  }
  return backend;
}
