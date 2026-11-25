import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseBackend } from "@/api";
import type { InstallationRepo, MyOrg, OnboardingApi, WorkflowPreview } from "@/api/onboarding";
import type { WireRunDetail } from "@/api/wire";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { lastOrg, rememberOrg, resetDirectory } from "@/lib/directory";
import {
  buildOnboardRows,
  hasRunnableWorkflow,
  liveContexts,
  ONBOARD_REPOS_MAX,
  previewRunJobNames,
  reposStepView,
  type RepoChoice,
  runFinished,
} from "@/lib/onboarding";
import { loadSession, useSession } from "@/lib/session";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { AgentSlot } from "./agent-slot";
import { getOnboardingApi } from "./api";
import { FinishView, NoWorkflowsHint, type RefusedJob } from "./finish-view";
import { InstallModal } from "./install-modal";
import { WorkflowPreviewView } from "./preview-view";
import { RepoTable } from "./repo-table";

export const STEPS = ["org", "repos", "preview", "run"] as const;
export type Step = (typeof STEPS)[number];
export type OnboardingSearch = {
  step?: Step | undefined;
  org?: string | undefined;
  installation?: string | undefined;
};

const STEP_LABELS: Record<Step, string> = {
  org: "Org",
  repos: "Repositories",
  preview: "Workflows",
  run: "First run",
};

/** The `?step=&org=&installation=` of the route, each accepted only if it has the right shape. */
export function validateOnboardingSearch(s: Record<string, unknown>): OnboardingSearch {
  const out: OnboardingSearch = {};
  if (typeof s.step === "string" && (STEPS as readonly string[]).includes(s.step))
    out.step = s.step as Step;
  if (typeof s.org === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(s.org)) out.org = s.org;
  if (typeof s.installation === "string" && /^\d{1,20}$/.test(s.installation))
    out.installation = s.installation;
  return out;
}

const msg = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);
const canAdminister = (role: string): boolean => role === "owner" || role === "admin";

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-[13px]" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={s === step ? "step" : undefined}
          className={cn(s === step ? "font-semibold text-foreground" : "text-faint")}
        >
          {i + 1}. {STEP_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

export function OnboardingPage() {
  const session = useSession();
  const fixture = chooseBackend() === "fixture";
  // The account operations take a web session and nothing else: a token cannot onboard.
  if (!fixture && session.status !== "signed-in")
    return (
      <EmptyState title="Sign in with GitHub to connect repositories">
        Onboarding runs on your GitHub sign-in. An API token cannot create orgs or install the App.
      </EmptyState>
    );
  return <Wizard api={getOnboardingApi()} />;
}

export function Wizard({ api }: { api: OnboardingApi }) {
  const search = useSearch({ strict: false }) as OnboardingSearch;
  const navigate = useNavigate();
  const orgs = useAsync(() => api.listMyOrgs(), [api]);
  const org = search.org ?? lastOrg() ?? null;
  const step: Step = search.step ?? "org";
  const go = useCallback(
    (next: OnboardingSearch) => void navigate({ to: "/onboarding", search: next }),
    [navigate],
  );

  // A step past the org step needs an org the person can administer; anything else starts over.
  const myOrg = orgs.data?.find((o) => o.slug === org) ?? null;
  const needsOrg = step !== "org";
  const ready = orgs.data !== null;
  const orgOk = myOrg !== null && canAdminister(myOrg.role);
  useEffect(() => {
    if (ready && needsOrg && !orgOk) go({ step: "org" });
  }, [ready, needsOrg, orgOk, go]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Connect repositories</h1>
      <p className="mb-4 mt-0.5 text-sm text-dim">
        Pick an org, install the GitHub App, choose repositories and run CI once.
      </p>
      <Stepper step={step} />
      {orgs.error ? (
        <ErrorState message={orgs.error} onRetry={orgs.reload} />
      ) : step === "org" ? (
        <OrgStep
          api={api}
          orgs={orgs.data}
          onPick={(slug) => {
            rememberOrg(slug);
            go({ step: "repos", org: slug });
          }}
          onCreated={(slug) => {
            // The session's own org list is out of date until it is read again.
            resetDirectory();
            void loadSession();
            rememberOrg(slug);
            go({ step: "repos", org: slug });
          }}
        />
      ) : !ready || !myOrg || !orgOk ? (
        <Skeleton className="h-32 w-full" />
      ) : step === "repos" ? (
        <ReposStep
          api={api}
          org={myOrg}
          installation={search.installation}
          onInstallation={(id) => go({ step: "repos", org: myOrg.slug, installation: id })}
          onContinue={(installation) => go({ step: "preview", org: myOrg.slug, installation })}
        />
      ) : search.installation === undefined ? (
        <EmptyState title="No installation chosen">
          <Link to="/onboarding" search={{ step: "repos", org: myOrg.slug }} className="underline">
            Choose repositories first.
          </Link>
        </EmptyState>
      ) : (
        <PostRepos
          api={api}
          org={myOrg.slug}
          installation={search.installation}
          step={step}
          go={go}
        />
      )}
    </div>
  );
}

// ---- 1. org -----------------------------------------------------------------------------------

function OrgStep({
  api,
  orgs,
  onPick,
  onCreated,
}: {
  api: OnboardingApi;
  orgs: MyOrg[] | null;
  onPick: (slug: string) => void;
  onCreated: (slug: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api.createOrg({ slug: slug.trim(), displayName: name.trim() }).then(
      (r) => {
        setBusy(false);
        onCreated(r.org.slug);
      },
      // The server's own refusal (not enabled for this account, slug taken, rate limit).
      (err: unknown) => {
        setBusy(false);
        setError(msg(err, "Could not create the org."));
      },
    );
  };
  return (
    <div className="space-y-8">
      <section aria-labelledby="pick-org" className="space-y-2">
        <h2 id="pick-org" className="text-sm font-semibold">
          Your orgs
        </h2>
        {orgs === null ? (
          <Skeleton className="h-20 w-full" />
        ) : orgs.length === 0 ? (
          <p className="text-sm text-dim">You are not in an org yet. Create one below.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {orgs.map((o) => {
              const ok = canAdminister(o.role);
              return (
                <li key={o.slug} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{o.display_name}</div>
                    <div className="text-xs text-dim">
                      {o.slug}, you are {o.role}
                      {ok ? "" : ". Only an owner or admin can connect repositories."}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!ok}
                    aria-label={`Use ${o.display_name}`}
                    onClick={() => onPick(o.slug)}
                  >
                    Use this org
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="create-org" className="space-y-2">
        <h2 id="create-org" className="text-sm font-semibold">
          Create an org
        </h2>
        <form onSubmit={create} className="space-y-3">
          <label className="block text-[13px]">
            Slug
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="acme"
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              required
              className="mt-1"
            />
            <span className="text-xs text-dim">Lowercase letters, digits and dashes.</span>
          </label>
          <label className="block text-[13px]">
            Display name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              maxLength={80}
              required
              className="mt-1"
            />
          </label>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Creating..." : "Create org"}
          </Button>
          {error ? (
            <p role="alert" className="text-[13px] text-st-failure">
              {error}
            </p>
          ) : null}
        </form>
      </section>
    </div>
  );
}

// ---- 2 and 3. install and repos ---------------------------------------------------------------

function ReposStep({
  api,
  org,
  installation: fromUrl,
  onInstallation,
  onContinue,
}: {
  api: OnboardingApi;
  org: MyOrg;
  installation: string | undefined;
  onInstallation: (id: string) => void;
  onContinue: (installation: string) => void;
}) {
  const [modal, setModal] = useState<"install" | "configure" | null>(null);
  // Without an installation in the URL, the org's own bound installations come first: the install
  // modal is for an org that has none.
  const bound = useAsync(
    () => (fromUrl ? Promise.resolve([]) : api.listOrgInstallations({ org: org.slug })),
    [api, org.slug, fromUrl],
  );
  const view = reposStepView(fromUrl, bound);
  const installation = view.kind === "repos" ? view.installation : undefined;
  // The modal opens at once for an org with no installation; the person can close and reopen it.
  const needsInstall = view.kind === "install";
  const [dismissed, setDismissed] = useState(false);
  const modalState = modal ?? (needsInstall && !dismissed ? "install" : null);
  const repos = useAsync(
    () =>
      installation
        ? api.listInstallationRepos({ org: org.slug, installationId: installation })
        : Promise.resolve(null),
    [api, org.slug, installation],
  );
  const [choices, setChoices] = useState<Record<string, RepoChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = repos.data;
  const rows = useMemo(() => (list ? buildOnboardRows(list, choices) : []), [list, choices]);

  const submit = () => {
    if (!installation) return;
    if (rows.length === 0) return onContinue(installation);
    setBusy(true);
    setError(null);
    api.onboardRepos({ org: org.slug, installationId: installation, repos: rows }).then(
      () => {
        setBusy(false);
        onContinue(installation);
      },
      (e: unknown) => {
        setBusy(false);
        setError(msg(e, "Could not update the repositories."));
      },
    );
  };

  return (
    <div className="space-y-4">
      <InstallModal
        api={api}
        org={org.slug}
        open={modalState !== null}
        onOpenChange={(o) => {
          if (o) return;
          setModal(null);
          setDismissed(true);
        }}
        {...(modalState === "configure" && installation ? { installationId: installation } : {})}
        onInstalled={(id) => {
          const same = id === installation;
          setModal(null);
          setChoices({});
          if (same) repos.reload();
          else onInstallation(id);
        }}
      />
      {view.kind === "loading" ? (
        <Skeleton className="h-40 w-full" />
      ) : view.kind === "error" ? (
        <ErrorState
          message={bound.error ?? "Could not look up the installations."}
          onRetry={bound.reload}
        />
      ) : view.kind === "install" ? (
        <EmptyState
          title="Install the GitHub App"
          action={
            <Button type="button" size="sm" onClick={() => setModal("install")}>
              Install on GitHub
            </Button>
          }
        >
          Turntable reads your repositories through the App. Nothing is enabled until you choose.
        </EmptyState>
      ) : repos.error ? (
        <ErrorState message={repos.error} onRetry={repos.reload} />
      ) : list === null ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {list.length === 0 ? (
            <p className="text-sm text-dim">
              This installation grants no repositories yet. Grant some on GitHub.
            </p>
          ) : (
            <RepoTable
              repos={list}
              choices={choices}
              disabled={busy}
              onChange={(id, next) => setChoices((c) => ({ ...c, [id]: next }))}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="ghost" onClick={() => setModal("configure")}>
              Grant more repos on GitHub
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setModal("install")}>
              Add another GitHub account
            </Button>
            <Button
              type="button"
              className="ml-auto"
              disabled={busy || rows.length > ONBOARD_REPOS_MAX}
              onClick={submit}
            >
              {busy ? "Saving..." : "Continue"}
            </Button>
          </div>
          {rows.length > ONBOARD_REPOS_MAX ? (
            <p role="alert" className="text-[13px] text-st-failure">
              Choose at most {ONBOARD_REPOS_MAX} repositories at a time.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[13px] text-st-failure">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---- 4 and 5. preview and first run -----------------------------------------------------------

type PreviewCache = Map<string, Promise<WorkflowPreview>>;

function PostRepos({
  api,
  org,
  installation,
  step,
  go,
}: {
  api: OnboardingApi;
  org: string;
  installation: string;
  step: Step;
  go: (s: OnboardingSearch) => void;
}) {
  const repos = useAsync(
    () => api.listInstallationRepos({ org, installationId: installation }),
    [api, org, installation],
  );
  const cache = useRef<PreviewCache>(new Map());
  const loadPreview = useCallback(
    (project: string): Promise<WorkflowPreview> => {
      let p = cache.current.get(project);
      if (!p) {
        p = api.previewWorkflows({ org, project });
        p.catch(() => cache.current.delete(project));
        cache.current.set(project, p);
      }
      return p;
    },
    [api, org],
  );
  if (repos.error) return <ErrorState message={repos.error} onRetry={repos.reload} />;
  if (!repos.data) return <Skeleton className="h-40 w-full" />;
  const enabled = repos.data.filter((r) => r.project !== null && !r.paused);
  if (enabled.length === 0)
    return (
      <EmptyState
        title="No repository is enabled"
        action={
          <Link
            to="/onboarding"
            search={{ step: "repos", org, installation }}
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            Back to repositories
          </Link>
        }
      >
        Tick at least one repository to see its workflows and run CI.
      </EmptyState>
    );
  return step === "preview" ? (
    <PreviewStep
      enabled={enabled}
      loadPreview={loadPreview}
      onBack={() => go({ step: "repos", org, installation })}
      onContinue={() => go({ step: "run", org, installation })}
    />
  ) : (
    <RunStep
      api={api}
      org={org}
      installation={installation}
      enabled={enabled}
      loadPreview={loadPreview}
      onReload={repos.reload}
    />
  );
}

function ProjectPreview({
  repo,
  loadPreview,
}: {
  repo: InstallationRepo;
  loadPreview: (project: string) => Promise<WorkflowPreview>;
}) {
  const project = repo.project as string;
  const preview = useAsync(() => loadPreview(project), [project, loadPreview]);
  return (
    <section aria-labelledby={`pv-${project}`} className="space-y-2">
      <h2 id={`pv-${project}`} className="font-mono text-sm font-semibold">
        {repo.repo}
      </h2>
      {preview.error ? (
        <ErrorState message={preview.error} onRetry={preview.reload} />
      ) : preview.data ? (
        <WorkflowPreviewView preview={preview.data} />
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
    </section>
  );
}

function PreviewStep({
  enabled,
  loadPreview,
  onBack,
  onContinue,
}: {
  enabled: InstallationRepo[];
  loadPreview: (project: string) => Promise<WorkflowPreview>;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-dim">
        This is what Turntable would do with each workflow on the default branch. Nothing has run.
      </p>
      {enabled.map((r) => (
        <ProjectPreview key={r.repo_id} repo={r} loadPreview={loadPreview} />
      ))}
      <div className="flex gap-3">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" className="ml-auto" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}

const POLL_RUN_MS = 4_000;

function RunStep({
  api,
  org,
  installation,
  enabled,
  loadPreview,
  onReload,
}: {
  api: OnboardingApi;
  org: string;
  installation: string;
  enabled: InstallationRepo[];
  loadPreview: (project: string) => Promise<WorkflowPreview>;
  onReload: () => void;
}) {
  const [repoId, setRepoId] = useState(enabled[0]?.repo_id ?? "");
  const repo = enabled.find((r) => r.repo_id === repoId) ?? (enabled[0] as InstallationRepo);
  const project = repo.project as string;
  const preview = useAsync(() => loadPreview(project), [project, loadPreview]);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<WireRunDetail | null>(null);
  const [live, setLive] = useState({ busy: false, error: null as string | null, done: false });

  // A new project means a new first run.
  useEffect(() => {
    setRunId(null);
    setRun(null);
    setError(null);
  }, [project]);

  useEffect(() => {
    if (runId === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await api.getRun({ org, runId });
        if (!alive) return;
        setRun(r);
        if (runFinished(r.state)) return;
      } catch (e) {
        if (alive) setError(msg(e, "Could not read the run."));
      }
      if (alive) timer = setTimeout(() => void tick(), POLL_RUN_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, org, runId]);

  const runNow = () => {
    setStarting(true);
    setError(null);
    api.runDefaultBranch({ org, project }).then(
      (r) => {
        setStarting(false);
        setRunId(r.run_id);
      },
      (e: unknown) => {
        setStarting(false);
        setError(msg(e, "Could not start the run."));
      },
    );
  };

  const goLive = () => {
    setLive({ busy: true, error: null, done: false });
    api
      .onboardRepos({
        org,
        installationId: installation,
        repos: [{ repo_id: repo.repo_id, enable: true, mode: "live" }],
      })
      .then(
        () => {
          setLive({ busy: false, error: null, done: true });
          onReload();
        },
        (e: unknown) => setLive({ busy: false, error: msg(e, "Could not go live."), done: false }),
      );
  };

  const pv = preview.data;
  const noWorkflows = pv !== null && !hasRunnableWorkflow(pv.workflows);
  const refused: RefusedJob[] = (pv?.workflows ?? []).flatMap((w) =>
    w.jobs
      .filter((j) => j.verdict === "fail")
      .map((j) => ({
        workflow: w.path,
        name: j.name ?? j.job_id,
        reason: j.reason ?? null,
        fix: j.fix ?? null,
      })),
  );
  const names =
    run && run.jobs.length > 0
      ? run.jobs.map((j) => j.name)
      : previewRunJobNames(pv?.workflows ?? []);

  return (
    <div className="space-y-6">
      {enabled.length > 1 ? (
        <label className="block text-[13px]">
          Project
          <select
            value={repo.repo_id}
            onChange={(e) => setRepoId(e.target.value)}
            className="ml-2 h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px]"
          >
            {enabled.map((r) => (
              <option key={r.repo_id} value={r.repo_id}>
                {r.repo}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {noWorkflows ? <NoWorkflowsHint /> : null}
      {runId === null ? (
        <div className="space-y-2">
          <p className="text-sm text-dim">
            Runs the default branch of <span className="font-mono">{repo.repo}</span> once.
          </p>
          <Button type="button" disabled={starting} onClick={runNow}>
            {starting ? "Starting..." : "Run CI now"}
          </Button>
          {error ? (
            <p role="alert" className="text-[13px] text-st-failure">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <FinishView
            project={repo.repo}
            run={run}
            runLink={
              <Link
                to="/$org/$project/runs/$runId"
                params={{ org, project, runId }}
                className="underline underline-offset-4"
              >
                Open the live run
              </Link>
            }
            refused={refused}
            contexts={liveContexts(names)}
            mode={live.done ? "live" : repo.mode}
            canGoLive
            goLive={live}
            onGoLive={goLive}
            passkeySlot={
              <>
                An org owner enrols the first approver with a passkey, once.{" "}
                <Link
                  to="/$org/-/approvers"
                  params={{ org }}
                  className="underline underline-offset-4"
                >
                  Enrol your passkey
                </Link>
              </>
            }
            agentSlot={<AgentSlot api={api} org={org} />}
          />
          {error ? (
            <p role="alert" className="text-[13px] text-st-failure">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
