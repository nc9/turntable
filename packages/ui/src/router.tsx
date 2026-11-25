import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { JOB_STATES, type JobState } from "@/api/types";
import { Home, NotFound } from "@/features/shell/home";
import { Shell } from "@/features/shell/shell";
import { OrgPage } from "@/features/runs/org-page";
import { RunsPage } from "@/features/runs/runs-page";
import { RunPage } from "@/features/runs/run-page";
import { JobPage } from "@/features/runs/job-page";
import { IngestPage } from "@/features/runs/ingest-page";
import { ApproveEnvironmentPage } from "@/features/runs/approve-environment-page";
import { ApproversPage } from "@/features/runs/approvers-page";
import { QuotasPage } from "@/features/runs/quotas-page";
import { UsagePage } from "@/features/runs/usage-page";
import { OrgSettingsPage } from "@/features/settings/org-settings-page";
import { ReleaseLanePage } from "@/features/settings/release-lane-page";
import { InstanceSettingsPage } from "@/features/instance/settings-page";
import { InstanceQuotasPage } from "@/features/instance/quotas-page";
import { InstanceProjectsPage } from "@/features/instance/projects-page";
import { InstanceBackupsPage } from "@/features/instance/backups-page";
import { InstanceTokenPage } from "@/features/instance/token-page";
import { OnboardingPage, validateOnboardingSearch } from "@/features/onboarding/wizard";
import { parseFeedSearch } from "@/lib/activity";
import { sanitizeNext } from "@/lib/session";
import { SettingsPage } from "@/features/runs/settings-page";
import { NotificationPrefsPage, NotificationsPage } from "@/features/shell/notifications-page";

export type RunsSearch = {
  status?: JobState | undefined;
  branch?: string | undefined;
  event?: string | undefined;
};
export type JobSearch = { attempt?: number | undefined };

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

// Home is the activity feed across every org ("All orgs"). Its filters live in the URL.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
  validateSearch: parseFeedSearch,
});

// The sign-in routes render nothing themselves: the shell shows the screen (or sends a signed-in
// visitor on), so the URL bar says where a logged-out visitor is. `next` is kept only if it is a
// same-origin relative path.
const signInSearch = (s: Record<string, unknown>): { next?: string } => {
  const next = sanitizeNext(s.next);
  return next ? { next } : {};
};
const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: () => null,
  validateSearch: signInSearch,
});
const tokenSignInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in/token",
  component: () => null,
  validateSearch: signInSearch,
});

// The onboarding wizard: connect an org, install the App, pick repos, run CI once. A static path,
// so it ranks above "/$org"; the server marks it with its own COOP header for the install popup.
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
  validateSearch: validateOnboardingSearch,
});

const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org",
  component: OrgPage,
});

const ingestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/ingest",
  component: IngestPage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/$project",
  component: RunsPage,
  validateSearch: (s: Record<string, unknown>): RunsSearch => {
    const out: RunsSearch = {};
    if (typeof s.status === "string" && (JOB_STATES as readonly string[]).includes(s.status))
      out.status = s.status as JobState;
    if (typeof s.branch === "string" && s.branch) out.branch = s.branch;
    if (typeof s.event === "string" && s.event) out.event = s.event;
    return out;
  },
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/$project/runs/$runId",
  component: RunPage,
});

const jobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/$project/runs/$runId/jobs/$jobId",
  component: JobPage,
  validateSearch: (s: Record<string, unknown>): JobSearch => {
    const n = Number(s.attempt);
    return Number.isInteger(n) && n > 0 ? { attempt: n } : {};
  },
});

const approveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/$project/runs/$runId/approve",
  component: ApproveEnvironmentPage,
  validateSearch: (s: Record<string, unknown>): { environment?: string } =>
    typeof s.environment === "string" && s.environment ? { environment: s.environment } : {},
});

const approversRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/approvers",
  component: ApproversPage,
});

const quotasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/quotas",
  component: QuotasPage,
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/usage",
  component: UsagePage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: NotificationsPage,
});
const notificationPrefsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications/settings",
  component: NotificationPrefsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/$project/settings",
  component: SettingsPage,
});

const orgSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/settings",
  component: OrgSettingsPage,
});

const releaseLaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$org/-/release-lane",
  component: ReleaseLanePage,
});

// The instance-administrator area. The shell renders it with its own sign-in instead of the org
// shell (see Shell). "-" is not a valid org slug, so these never collide with an org.
const instanceIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/-/instance",
  beforeLoad: () => {
    throw redirect({ to: "/-/instance/settings" });
  },
});
const instanceRoutes = [
  ["settings", InstanceSettingsPage],
  ["quotas", InstanceQuotasPage],
  ["projects", InstanceProjectsPage],
  ["backups", InstanceBackupsPage],
  ["token", InstanceTokenPage],
].map(([name, component]) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/-/instance/${name as string}`,
    component: component as () => React.JSX.Element,
  }),
);

export const routeTree = rootRoute.addChildren([
  instanceIndexRoute,
  ...instanceRoutes,
  signInRoute,
  tokenSignInRoute,
  indexRoute,
  onboardingRoute,
  orgRoute,
  ingestRoute,
  runsRoute,
  runRoute,
  jobRoute,
  approveRoute,
  approversRoute,
  quotasRoute,
  usageRoute,
  orgSettingsRoute,
  releaseLaneRoute,
  settingsRoute,
  notificationsRoute,
  notificationPrefsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
