import { useSyncExternalStore } from "react";

// The instance-administrator (`tti_`) token. It is a separate sign-in from the org session in
// lib/auth.ts: its own storage key, its own store, and it is read only by the instance client
// (api/instance.ts). It is never handed to the org client, the MCP endpoint or the realtime
// socket, and an org token is never sent to an instance route. Like the org token it lives in
// memory and in sessionStorage (cleared when the tab closes), never in a URL or localStorage.

export const INSTANCE_TOKEN_KEY = "tt-instance-token";

type State = {
  token: string | null;
  notice: string | null;
  /** The secret of a token just minted by rotation: in memory only, shown once. */
  rotated: string | null;
};

function read(): string | null {
  try {
    return sessionStorage.getItem(INSTANCE_TOKEN_KEY);
  } catch {
    return null;
  }
}
function write(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(INSTANCE_TOKEN_KEY);
    else sessionStorage.setItem(INSTANCE_TOKEN_KEY, value);
  } catch {
    // storage blocked: the token stays in memory for this page load only
  }
}

let state: State = { token: read(), notice: null, rotated: null };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const getInstanceToken = (): string | null => state.token;

export function connectInstance(token: string, notice: string | null = null): void {
  write(token);
  state = { token, notice, rotated: null };
  emit();
}

/** Forget the instance token (sign out, rotation, or the server rejected it). */
export function disconnectInstance(notice: string | null = null): void {
  write(null);
  state = { token: null, notice, rotated: state.rotated };
  emit();
}

/**
 * Rotation revoked the token this session held: drop it and keep the new secret in memory, so the
 * page can show it once. It is not stored; the session signs in with it, or ends.
 */
export function completeRotation(secret: string): void {
  write(null);
  state = { token: null, notice: null, rotated: secret };
  emit();
}

/** The new secret has been seen: forget it. */
export function clearRotated(): void {
  state = { ...state, rotated: null };
  emit();
}

export function useInstanceAuth(): State {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
