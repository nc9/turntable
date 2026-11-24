// Turns the server's refusal of a web-session write into words a person can act on. A session
// can only invite members; `create_api_token` and admin or owner invites need a fresh passkey
// step-up; every other write needs an API token. The server says which with `forbidden` plus
// `details.reason`.

export const PASSKEY_MESSAGE = "This needs passkey confirmation.";
export const TOKEN_MESSAGE = "Use an API token for this: signed-in web sessions cannot do it.";

const STEP_UP_REASONS: Record<string, string> = {
  step_up_required: PASSKEY_MESSAGE,
  step_up_unknown: "That passkey confirmation was not recognised. Confirm again.",
  step_up_expired: "That passkey confirmation expired. Confirm again.",
  step_up_reused: "That passkey confirmation was already used. Confirm again.",
  step_up_wrong_action: "That passkey confirmation was for a different action. Confirm again.",
  step_up_bad_key: "That passkey is not enrolled for this account. Use a registered passkey.",
  step_up_reenrol: "Your passkey needs to be enrolled again before it can confirm this.",
  step_up_bad_assertion: "The passkey confirmation did not verify. Try again.",
  step_up_unavailable: "Passkey confirmation is not available on this instance. Use an API token.",
};

/**
 * The message for a refused request, or `undefined` when the refusal is not a session or step-up
 * one (the server's own text then stands). `step_up_required` is also what the server returns for
 * an op that takes no step-up at all, and its text then says to use a token.
 */
export function refusalMessage(
  code: string,
  message: string,
  details: unknown,
): string | undefined {
  if (code !== "forbidden") return undefined;
  const reason =
    details && typeof details === "object" && "reason" in details
      ? (details as { reason?: unknown }).reason
      : undefined;
  if (typeof reason !== "string") return undefined;
  if (reason === "step_up_required" && /use a token/i.test(message)) return TOKEN_MESSAGE;
  return STEP_UP_REASONS[reason];
}
