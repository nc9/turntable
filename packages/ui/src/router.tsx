import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { JOB_STATES, type JobState } from "@/api/types";
import { HomeRedirect, NotFound } from "@/features/shell/home";
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
import { SettingsPage } from "@/features/runs/settings-page";

export type RunsSearch = {
  status?: JobState | undefined;
  branch?: string | undefined;
  event?: string | undefined;
};
export type JobSearch = { attempt?: number | undefined };

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRedirect,
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

const routeTree = rootRoute.addChildren([
  indexRoute,
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
  settingsRoute,
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
