// The numeric GitHub account id an approver key is enrolled for. Step-up for a web session
// compares it with the session person's id, so a recycled or renamed login cannot borrow a key.
// Any failure to resolve it refuses the enrolment (fail closed): a key with no id could never
// step up, and silently enrolling one would hide that.
import type { GithubUserLookup } from "../github/api";
import { OpError } from "../ops/errors";

export async function resolveGithubUserId(
  lookup: GithubUserLookup | undefined,
  login: string,
): Promise<string> {
  if (!lookup) {
    throw new OpError(
      "unavailable",
      "enrolling an approver needs a configured GitHub App to resolve the forge login to its numeric id",
    );
  }
  let id: string | undefined;
  try {
    id = await lookup.idOfLogin(login.trim().toLowerCase());
  } catch {
    throw new OpError("unavailable", "GitHub could not be asked to resolve that login; try again");
  }
  if (id === undefined) {
    throw new OpError("invalid_input", "that forge login is not a GitHub account");
  }
  return id;
}
