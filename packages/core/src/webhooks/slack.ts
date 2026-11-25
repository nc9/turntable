// The Slack body of an outbound webhook (#611). Hold-list file: it decides what leaves the
// instance. The text is FIXED templates over slugs, ids and a count: no commit message, branch,
// workflow, job or step name, and nothing else from the forge, ever. Slack's three control
// characters are escaped anyway.

export type WebhookEnvelope = {
  cursor: number;
  id: string;
  type: string;
  org: string;
  project: string | null;
  run_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  payload: unknown;
  created_at: string;
};

/** The event types a Slack endpoint is given by default: the ones with a notification kind. */
export const SLACK_EVENT_TYPES = [
  "run.finished",
  "infra.error",
  "quota.reached",
  "approval.required",
] as const;

const escape = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are dropped
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const SAFE = /^[A-Za-z0-9_.-]{1,64}$/;
const slug = (s: string | null): string => (s !== null && SAFE.test(s) ? s : "?");

/** The message for an event, or null when the event is not one of the notification kinds. */
export function slackText(e: WebhookEnvelope): string | null {
  const where = e.project === null ? slug(e.org) : `${slug(e.org)}/${slug(e.project)}`;
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  const run = e.run_id !== null && SAFE.test(e.run_id) ? ` (run ${e.run_id})` : "";
  switch (e.type) {
    case "run.finished":
      return payload.status === "failure" ? escape(`:x: Run failed in ${where}${run}`) : null;
    case "infra.error":
      return escape(`:warning: Infrastructure error in ${where}${run}`);
    case "quota.reached": {
      const metric =
        typeof payload.metric === "string" && SAFE.test(payload.metric) ? payload.metric : null;
      return escape(
        `:hourglass: Work is held in ${where}: quota reached${metric ? ` (${metric})` : ""}`,
      );
    }
    case "approval.required":
      return escape(`:lock: Approval waiting in ${where}${run}`);
    default:
      return null;
  }
}
