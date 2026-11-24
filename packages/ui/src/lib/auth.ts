import { useSyncExternalStore } from "react";

// Bearer token for the REST API. It lives in memory and in sessionStorage (cleared when the tab
// closes), never in a URL and never in localStorage. Real session auth (#13) replaces this.
// The org slug is not secret, but it is kept alongside so a reload does not ask again.

const TOKEN_KEY = "tt-token";
const ORG_KEY = "tt-org";

type AuthState = { token: string | null; org: string | null; notice: string | null };

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // storage blocked: the token stays in memory for this page load only
  }
}

let state: AuthState = { token: read(TOKEN_KEY), org: read(ORG_KEY), notice: null };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const getToken = (): string | null => state.token;
export const getOrg = (): string | null => state.org;

export function connect(token: string, org: string): void {
  write(TOKEN_KEY, token);
  write(ORG_KEY, org);
  state = { token, org, notice: null };
  emit();
}

/** Forget the token (sign out, or the server rejected it). */
export function disconnect(notice: string | null = null): void {
  write(TOKEN_KEY, null);
  state = { token: null, org: state.org, notice };
  emit();
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
