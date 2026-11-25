// The onboarding wizard's logic, kept apart from the components so it can be tested without a DOM:
// the claim watcher (when has the person finished installing the App?), the popup start, the
// repo submit payload and the check names to require. Nothing here renders anything.
import type {
  ChecksMode,
  ClaimStatus,
  InstallationRepo,
  OnboardRepoRow,
  PreviewWorkflow,
  StartedClaim,
} from "@/api/onboarding";

/**
 * What each checks mode does on GitHub, in the words every surface uses. A copy of
 * `CHECKS_MODE_LABELS` in core (the UI must not bundle core's schema module); a test keeps the two
 * equal.
 */
export const CHECKS_MODE_LABELS: Record<ChecksMode, string> = {
  off: "Off: runs on Turntable, posts nothing to GitHub (default)",
  shadow: "Shadow: posts neutral `shadow / <job>` checks that never block",
  live: "Live: posts `turntable / <job>` checks your rules can require",
};
export const CHECKS_MODES: readonly ChecksMode[] = ["off", "shadow", "live"];

/** The most repos one `onboard_repos` call takes. */
export const ONBOARD_REPOS_MAX = 100;

export const CLAIM_MESSAGE_TYPE = "turntable.claim";
export const CLAIM_POLL_MS = 5_000;
export const CLAIM_POLL_WINDOW_MS = 120_000;

// ---- the claim watcher ----------------------------------------------------------------------

export type ClaimOutcome =
  | { kind: "completed"; installationId: string | null; accountLogin: string | null }
  | { kind: "refused"; reason: string | null }
  | { kind: "expired" }
  /** Nothing arrived in the polling window; the person can check again. */
  | { kind: "timeout" };

/** The slice of `window` the watcher needs, so a test can stand in for it. */
export type MessageTarget = {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};

export type ClaimWatcherOptions = {
  claimId: string;
  /** The window that receives the popup's `postMessage`. */
  target: MessageTarget;
  /** `window.location.origin`. Only a message from exactly this origin counts. */
  origin: string;
  /** `get_installation_claim`. */
  getClaim: () => Promise<ClaimStatus>;
  onOutcome: (o: ClaimOutcome) => void;
  /**
   * Subscribe to `installation_claim.updated` for this org, when the transport can. Returns an
   * unsubscribe function. A web session cannot open the realtime socket today, so the page
   * passes none and the poll carries it.
   */
  subscribe?: (onEvent: (e: { claim_id: string; state: string }) => void) => () => void;
  pollMs?: number;
  windowMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
  now?: () => number;
};

/**
 * Watches one claim until it ends. Three signals can say "look now", and none of them is believed
 * on its own: each only triggers a read of `get_installation_claim`, so the server decides.
 *
 * - a `message` event from the popup, accepted only from our own origin with `type` and
 *   `claim_id` matching (anything else is ignored without a read);
 * - the `installation_claim.updated` event, when a subscription exists, for this claim id;
 * - a poll every `pollMs` for at most `windowMs`.
 *
 * Returns a stop function. The outcome is delivered once.
 */
export function watchClaim(o: ClaimWatcherOptions): () => void {
  const setI = o.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearI = o.clearInterval ?? ((id) => globalThis.clearInterval(id as never));
  const now = o.now ?? Date.now;
  const started = now();
  let done = false;
  let reading = false;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const stop = () => {
    done = true;
    o.target.removeEventListener("message", onMessage);
    if (timer !== null) clearI(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  const finish = (out: ClaimOutcome) => {
    if (done) return;
    stop();
    o.onOutcome(out);
  };

  const check = async () => {
    if (done || reading) return;
    reading = true;
    try {
      const s = await o.getClaim();
      if (s.state === "completed")
        finish({
          kind: "completed",
          installationId: s.installation_id ?? null,
          accountLogin: s.account_login ?? null,
        });
      else if (s.state === "refused") finish({ kind: "refused", reason: s.reason ?? null });
      else if (s.state === "expired") finish({ kind: "expired" });
    } catch {
      // a failed read is retried by the next signal or poll
    } finally {
      reading = false;
    }
  };

  function onMessage(e: MessageEvent): void {
    if (e.origin !== o.origin) return;
    const d = e.data as { type?: unknown; claim_id?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.type !== CLAIM_MESSAGE_TYPE || d.claim_id !== o.claimId) return;
    void check();
  }
  o.target.addEventListener("message", onMessage);

  unsubscribe =
    o.subscribe?.((e) => {
      if (e.claim_id === o.claimId) void check();
    }) ?? null;

  timer = setI(() => {
    if (done) return;
    if (now() - started >= (o.windowMs ?? CLAIM_POLL_WINDOW_MS)) {
      finish({ kind: "timeout" });
      return;
    }
    void check();
  }, o.pollMs ?? CLAIM_POLL_MS);

  return stop;
}

// ---- starting the install in a popup --------------------------------------------------------

/** Only http and https links are followed: a URL from the server is still not a script. */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export type PopupHandle = { closed: boolean; close(): void; location: { href: string } };

export type InstallStart =
  | { blocked: false; claimId: string; url: string; popup: PopupHandle }
  | { blocked: true; claimId: string; url: string };

/**
 * Starts the install. It must run synchronously inside the click handler up to its first `await`:
 * the popup is opened first, blank, because a browser blocks a `window.open` that follows a
 * network round trip. The claim is then started and the popup is sent to GitHub's URL. The opener
 * link is kept on purpose (no `noopener`): the callback page uses it to say it is done. If the
 * browser blocked the popup, the URL comes back so the page can offer a same-tab link.
 */
export async function beginInstall(o: {
  open: () => PopupHandle | null;
  start: () => Promise<StartedClaim>;
}): Promise<InstallStart> {
  const popup = o.open();
  let claim: StartedClaim;
  try {
    claim = await o.start();
  } catch (e) {
    popup?.close();
    throw e;
  }
  const url = safeHttpUrl(claim.url);
  if (!url) {
    popup?.close();
    throw new Error("The server returned a link that is not an http(s) address.");
  }
  if (!popup || popup.closed) return { blocked: true, claimId: claim.claim_id, url };
  popup.location.href = url;
  return { blocked: false, claimId: claim.claim_id, url, popup };
}

// ---- the repo table -------------------------------------------------------------------------

export type RepoChoice = { ticked: boolean; mode: ChecksMode; modeTouched: boolean };

/** The starting choice for a repo: a new one is unticked at Off; an existing one shows as it is. */
export function initialChoice(r: InstallationRepo): RepoChoice {
  return r.status === "new"
    ? { ticked: false, mode: "off", modeTouched: false }
    : { ticked: !r.paused, mode: r.mode ?? "off", modeTouched: false };
}

/**
 * The `onboard_repos` rows. A ticked repo is sent with `enable: true`; an existing repo that was
 * on and is now unticked is sent with `enable: false` (this pauses it). A repo left as it was is
 * not sent. `mode` is sent for a new repo (its chosen mode, Off by default) and for an existing
 * repo ONLY when the person changed its mode: omitted, the server keeps the current one.
 */
export function buildOnboardRows(
  repos: readonly InstallationRepo[],
  choices: Readonly<Record<string, RepoChoice>>,
): OnboardRepoRow[] {
  const rows: OnboardRepoRow[] = [];
  for (const r of repos) {
    const c = choices[r.repo_id] ?? initialChoice(r);
    if (r.status === "new") {
      if (c.ticked) rows.push({ repo_id: r.repo_id, enable: true, mode: c.mode });
      continue;
    }
    const wasOn = !r.paused;
    if (c.ticked) {
      rows.push({
        repo_id: r.repo_id,
        enable: true,
        ...(c.modeTouched ? { mode: c.mode } : {}),
      });
    } else if (wasOn) {
      rows.push({ repo_id: r.repo_id, enable: false });
    }
  }
  return rows;
}

// ---- the finish screen ----------------------------------------------------------------------

/** The check name GitHub shows in live mode. The matrix leg is already part of a run job's name. */
export const liveContext = (jobName: string): string => `turntable / ${jobName}`;

/** Distinct `turntable / <job>` names, in order, for a ruleset's required checks. */
export function liveContexts(jobNames: readonly string[]): string[] {
  return [...new Set(jobNames.map(liveContext))];
}

/** Job names the preview says would run, for the repos' workflows (names, else job keys). */
export function previewRunJobNames(workflows: readonly PreviewWorkflow[]): string[] {
  const out: string[] = [];
  for (const w of workflows)
    for (const j of w.jobs) if (j.verdict === "run") out.push(j.name ?? j.job_id);
  return out;
}

/** Whether a preview has anything Turntable could run: no workflow files, or none ingested. */
export function hasRunnableWorkflow(workflows: readonly PreviewWorkflow[]): boolean {
  return workflows.some((w) => w.ingested && w.jobs.some((j) => j.verdict === "run"));
}

export const SAMPLE_WORKFLOW = `name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hello from Turntable"
`;

const FINISHED_STATES = ["success", "failure", "infra_error", "cancelled", "skipped"];
export const runFinished = (state: string): boolean => FINISHED_STATES.includes(state);
