import { TarFormatError } from "@turntable/act-runner";

/**
 * The attempt outcome for a checkout whose tarball the strict scanner refused, or undefined for any
 * other error. A named kind (`tree_scan`) with the scanner's reason, so it is never `other`, and
 * `logLine` is the line for the job log.
 */
export function treeScanOutcome(
  e: unknown,
):
  | { outcome: { state: "infra_error"; infraKind: "tree_scan"; reason: string }; logLine: string }
  | undefined {
  if (!(e instanceof TarFormatError)) return undefined;
  const reason = `the checkout was refused by the tree scan: ${e.message.slice(0, 400)}`;
  return {
    outcome: { state: "infra_error", infraKind: "tree_scan", reason },
    logLine: `${reason}\n`,
  };
}
