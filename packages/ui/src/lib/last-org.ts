// The last org this browser used. A convenience only: it is validated against the orgs the person
// can reach before it is used, and it is never a credential.
export const LAST_ORG_KEY = "tt-last-org";

export function rememberOrg(slug: string): void {
  try {
    localStorage.setItem(LAST_ORG_KEY, slug);
  } catch {
    // storage unavailable
  }
}

export function lastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

// The last project opened in an org, so the project switcher can offer it first.
const LAST_PROJECT_PREFIX = "tt-last-project:";

export function rememberProject(org: string, project: string): void {
  try {
    localStorage.setItem(`${LAST_PROJECT_PREFIX}${org}`, project);
  } catch {
    // storage unavailable
  }
}

export function lastProject(org: string): string | null {
  try {
    return localStorage.getItem(`${LAST_PROJECT_PREFIX}${org}`);
  } catch {
    return null;
  }
}
