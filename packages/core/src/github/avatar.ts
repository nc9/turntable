// GitHub avatar URLs. They come from GitHub's own API (sign-in, installation facts), but they are
// stored and later rendered as an <img src>, so each one is held to a single origin on the way in:
// anything else is dropped and the UI falls back to initials. The UI's CSP allows exactly this
// origin for images and nothing else (ui-assets.ts).
export const AVATAR_ORIGIN = "https://avatars.githubusercontent.com";

/** The URL as a clean avatar-origin https URL, or null for anything else (never throws). */
export function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== AVATAR_ORIGIN) return null;
  if (u.username !== "" || u.password !== "" || u.hash !== "") return null;
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(u.pathname)) return null;
  return `${AVATAR_ORIGIN}${u.pathname}${u.search}`;
}
