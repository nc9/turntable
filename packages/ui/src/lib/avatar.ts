// GitHub avatars. The server only stores URLs on GitHub's avatar host and the CSP allows only that
// host for images, so this check is a second guard in the browser: anything else renders initials.
export const AVATAR_ORIGIN = "https://avatars.githubusercontent.com";

/** The URL if it is an https URL on GitHub's avatar host, else null (never throws). */
export function safeAvatarUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.origin === AVATAR_ORIGIN && u.username === "" && u.password === "" ? u.href : null;
  } catch {
    return null;
  }
}

/** Up to two letters for a name or login: "Acme Corp" gives "AC", "octocat" gives "OC". */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase();
}

// Icons learned from the activity feed, so the switchers can show an org or project icon without
// a request of their own. Keyed by slug; a convenience, never a source of truth.
const orgIcons = new Map<string, string>();
const projectIcons = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function learnAvatars(
  rows: readonly {
    org: string;
    orgAvatarUrl: string | null;
    project: string;
    projectAvatarUrl: string | null;
  }[],
): void {
  let changed = false;
  for (const r of rows) {
    const o = safeAvatarUrl(r.orgAvatarUrl);
    if (o && orgIcons.get(r.org) !== o) {
      orgIcons.set(r.org, o);
      changed = true;
    }
    const p = safeAvatarUrl(r.projectAvatarUrl);
    if (p && projectIcons.get(`${r.org}/${r.project}`) !== p) {
      projectIcons.set(`${r.org}/${r.project}`, p);
      changed = true;
    }
  }
  if (changed) {
    version += 1;
    for (const l of listeners) l();
  }
}

export const orgIcon = (org: string): string | null => orgIcons.get(org) ?? null;
export const projectIcon = (org: string, project: string): string | null =>
  projectIcons.get(`${org}/${project}`) ?? null;
export const subscribeAvatars = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
export const avatarsVersion = (): number => version;
