import { CheckoutLimitError } from "../run/checkout-child";

/**
 * The attempt outcome for a checkout that ran over one of its size budgets, or undefined for any
 * other error. A named kind (`fetch_limit`), never retried; the reason names the limit, its value
 * and the setting that raises it, and `logLine` is the line for the job log.
 */
export function fetchLimitOutcome(
  e: unknown,
):
  | { outcome: { state: "infra_error"; infraKind: "fetch_limit"; reason: string }; logLine: string }
  | undefined {
  if (!(e instanceof CheckoutLimitError)) return undefined;
  const reason = e.message.slice(0, 600);
  return {
    outcome: { state: "infra_error", infraKind: "fetch_limit", reason },
    logLine: `${reason}\n`,
  };
}
