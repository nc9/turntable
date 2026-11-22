// Who counts as one approver. The `person` label is free text anyone enrolling can choose, so it
// proves nothing: two labels for one forge login are one human. Identity is the lower-cased forge
// login (the thing the author check also uses). A key without a forge login has no identity: it
// counts toward no quorum and no approval at all (fail closed), and is shown as not counting.

export const normalizeLogin = (login: string): string => login.trim().toLowerCase();

/** The identity an approver key counts under, or null when it has none and so counts for nothing. */
export function approverIdentity(a: { forgeLogin?: string | null | undefined }): string | null {
  const login = a.forgeLogin?.trim();
  return login ? `login:${normalizeLogin(login)}` : null;
}

/** Why a key is not counted, or null when it is. */
export const NO_FORGE_LOGIN = "no forge login: an approval cannot be tied to a person";
export const notCountingReason = (a: { forgeLogin?: string | null | undefined }): string | null =>
  approverIdentity(a) === null ? NO_FORGE_LOGIN : null;
