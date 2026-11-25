// Web sessions (#430): the cookie, its server-side row, and the origin check. A session is a
// credential only for the REST adapter; MCP, the realtime socket and the event stream stay
// bearer-only. The browser holds an opaque random id in a `__Host-` cookie (Secure, HttpOnly,
// SameSite=Lax, Path=/, no Domain, so it is host-only); the database holds only its hash.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db";
import { findLiveSession, revokeSession, touchSession } from "../db/repos";
import { ambientSettings } from "../settings/ambient";
import { sessionAbsoluteDaysSetting, sessionIdleHoursSetting } from "../settings/definitions";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";

export const SESSION_COOKIE = "__Host-tt_session";
export const LOGIN_COOKIE = "__Host-tt_login";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A session row's last_seen_at is refreshed at most this often, so reads do not become writes. */
const TOUCH_MS = 60_000;

/** The hash stored for a session id. The prefix keeps it from colliding with any other hash. */
export const sessionHash = (id: string): string =>
  createHash("sha256").update(`tt-session.${id}`).digest("hex");

export const newSessionId = (): string => randomBytes(32).toString("base64url");

/** The CSRF value for a session's forms: derived from the id, so only its holder can compute it. */
export const csrfToken = (id: string): string =>
  createHash("sha256").update(`tt-csrf.${id}`).digest("base64url");

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export interface WebSessionsOptions {
  db: Db;
  /** The server's public URL. Its origin is the only origin a session request may come from. */
  publicUrl: string;
  settings?: SettingsRuntime | undefined;
  now?: () => number;
}

/** A session that resolved: whose it is, and the hash that names its row. */
export type LiveSession = { userId: string; hash: string };

export class WebSessions {
  readonly #o: WebSessionsOptions;
  readonly origin: string;

  constructor(o: WebSessionsOptions) {
    this.#o = o;
    // The configured origin, never the request's Host header, which a client controls.
    this.origin = new URL(o.publicUrl).origin;
  }

  now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** Idle and absolute lifetimes, in ms, from the settings registry. */
  async lifetimes(): Promise<{ idleMs: number; absoluteMs: number }> {
    const rt = this.#o.settings ?? ambientSettings();
    const idle = await resolveSetting(rt, this.#o.db, sessionIdleHoursSetting.key);
    const abs = await resolveSetting(rt, this.#o.db, sessionAbsoluteDaysSetting.key);
    return { idleMs: (idle.value as number) * HOUR_MS, absoluteMs: (abs.value as number) * DAY_MS };
  }

  /** CSRF: a state-changing request carries an Origin equal to the public origin. No Origin, no. */
  sameOrigin(req: Request): boolean {
    return req.headers.get("origin") === this.origin;
  }

  /** The session behind a cookie value, or undefined when it is unknown, revoked or expired. */
  async resolve(cookie: string): Promise<LiveSession | undefined> {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(cookie)) return undefined;
    const hash = sessionHash(cookie);
    const now = this.now();
    const { idleMs } = await this.lifetimes();
    const row = await findLiveSession(this.#o.db, hash, now, idleMs);
    if (!row) return undefined;
    if (now - row.lastSeenAt > TOUCH_MS) await touchSession(this.#o.db, hash, now).catch(() => {});
    return { userId: row.userId, hash };
  }

  /** Whether the session row with this hash is live (not revoked, expired or idle past its limit). */
  async isLive(hash: string): Promise<boolean> {
    const { idleMs } = await this.lifetimes();
    return (await findLiveSession(this.#o.db, hash, this.now(), idleMs)) !== undefined;
  }

  async revoke(cookie: string): Promise<void> {
    await revokeSession(this.#o.db, sessionHash(cookie), this.now());
  }

  setCookie(id: string, absoluteMs: number): string {
    return `${SESSION_COOKIE}=${id}; Max-Age=${Math.floor(absoluteMs / 1000)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
  }
}
