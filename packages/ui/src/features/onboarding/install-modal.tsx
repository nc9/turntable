import { ExternalLink } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import type { OnboardingApi, UserInstallation } from "@/api/onboarding";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAsync } from "@/lib/use-async";
import { beginInstall, type ClaimOutcome, type PopupHandle, watchClaim } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const msg = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

/** What the App is granted. The same words as the docs page. */
export const GRANTS = [
  "Checks: write (posts check runs on commits, only when a repo's mode is Shadow or Live).",
  "Contents: read (reads workflow files and your code to run CI).",
  "Metadata: read (repository names and ids).",
  "Pull requests: read (sees pull requests to run CI for them).",
] as const;

export const BOUND_ELSEWHERE = "connected to a different Turntable org";

/** The same-tab way back, for a browser that blocked the popup. */
export const RETURN_PATH = "/onboarding?step=repos";

export type InstallPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting" }
  | { kind: "blocked"; url: string }
  | { kind: "ended"; message: string; canCheckAgain: boolean };

export type InstallPanelProps = {
  /** The configure page of an existing installation instead of a fresh install. */
  configuring: boolean;
  phase: InstallPhase;
  error: string | null;
  onInstall: () => void;
  onCheckAgain: () => void;
  /** `null` while loading, hidden until the person opens the picker. */
  picker: { open: boolean; installations: UserInstallation[] | null; error: string | null };
  onOpenPicker: () => void;
  onPick: (id: string) => void;
  bindingId: string | null;
  bindError: string | null;
  onClose: () => void;
  /** The modal passes the dialog's own title and description so assistive tech reads them. */
  Title?: ComponentType<{ className?: string; children?: ReactNode }>;
  Description?: ComponentType<{ className?: string; children?: ReactNode }>;
};

/** The modal's body. Props in, markup out: the state lives in `InstallModal`. */
export function InstallPanel(p: InstallPanelProps) {
  const Title = p.Title ?? "h2";
  const Description = p.Description ?? "p";
  const busy = p.phase.kind === "starting" || p.phase.kind === "waiting";
  return (
    <div className="space-y-4 p-5">
      <div>
        <Title className="text-base font-semibold tracking-tight">
          {p.configuring ? "Grant more repositories" : "Install the Turntable GitHub App"}
        </Title>
        <Description className="mt-1 text-sm text-dim">
          {p.configuring
            ? "GitHub opens in a new window. Choose the repositories to add, then come back here."
            : "GitHub opens in a new window. Choose the account and the repositories, then come back here."}
        </Description>
      </div>
      <div>
        <h3 className="text-[13px] font-semibold">What the App is granted</h3>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-dim">
          {GRANTS.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
        <p className="mt-1.5 text-[13px] text-dim">
          It cannot push code or change settings. You can remove it any time in GitHub under
          Settings, Applications.
        </p>
      </div>

      <Button type="button" onClick={p.onInstall} disabled={busy} className="w-full">
        {p.phase.kind === "waiting" ? "Waiting for GitHub..." : "Install on GitHub"}
      </Button>

      {p.phase.kind === "waiting" ? (
        <p role="status" className="text-[13px] text-dim">
          Finish in the GitHub window. This page continues on its own.
        </p>
      ) : null}
      {p.phase.kind === "blocked" ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-line-strong bg-subtle p-3 text-[13px]"
        >
          <p>Your browser blocked the pop-up window. Continue in this tab instead:</p>
          <a
            href={p.phase.url}
            data-testid="same-tab-link"
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            <ExternalLink aria-hidden="true" />
            Continue to GitHub in this tab
          </a>
          <p className="text-dim">
            When you are done,{" "}
            <a className="underline" href={RETURN_PATH} data-testid="return-link">
              come back to the wizard
            </a>
            .
          </p>
        </div>
      ) : null}
      {p.phase.kind === "ended" ? (
        <div role="alert" className="space-y-2 text-[13px]">
          <p>{p.phase.message}</p>
          {p.phase.canCheckAgain ? (
            <Button type="button" size="sm" variant="secondary" onClick={p.onCheckAgain}>
              Check again
            </Button>
          ) : null}
        </div>
      ) : null}
      {p.error ? (
        <p role="alert" className="text-[13px] text-st-failure">
          {p.error}
        </p>
      ) : null}

      {p.configuring ? null : (
        <div className="border-t border-line pt-3">
          {p.picker.open ? (
            <InstallationPicker {...p} />
          ) : (
            <button
              type="button"
              onClick={p.onOpenPicker}
              className="text-[13px] underline underline-offset-4 hover:text-foreground"
            >
              Already installed? Pick the installation
            </button>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={p.onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function InstallationPicker(p: InstallPanelProps) {
  const { installations, error } = p.picker;
  return (
    <div className="space-y-2">
      <h3 className="text-[13px] font-semibold">Your installations</h3>
      {error ? (
        <p role="alert" className="text-[13px] text-st-failure">
          {error}
        </p>
      ) : installations === null ? (
        <p className="text-[13px] text-dim">Loading installations...</p>
      ) : installations.length === 0 ? (
        <p className="text-[13px] text-dim">GitHub shows no installation of this App for you.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {installations.map((i) => {
            const taken = i.bound === "other_org";
            return (
              <li key={i.installation_id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{i.account_login}</div>
                  <div className="text-xs text-dim">
                    {i.account_type === "Organization" ? "Organization" : "Personal account"},{" "}
                    {i.repository_selection === "all"
                      ? "all repositories"
                      : "selected repositories"}
                    {taken ? `, ${BOUND_ELSEWHERE}` : null}
                    {i.bound === "this_org" ? ", already connected to this org" : null}
                  </div>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  disabled={taken || p.bindingId !== null}
                  aria-label={`Use the installation on ${i.account_login}`}
                  onClick={() => p.onPick(i.installation_id)}
                >
                  {p.bindingId === i.installation_id ? "Connecting..." : "Use this"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {p.bindError ? (
        <p role="alert" className="text-[13px] text-st-failure">
          {p.bindError}
        </p>
      ) : null}
    </div>
  );
}

export type InstallModalProps = {
  api: OnboardingApi;
  org: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set to open the configure page of this installation (grant more repos). */
  installationId?: string;
  /** Called with the installation id once it is connected to the org. */
  onInstalled: (installationId: string) => void;
};

/**
 * The install modal. "Install on GitHub" opens the popup from the click, starts a popup claim and
 * waits for it to complete: by the popup's `postMessage`, or by the poll. "Already installed?"
 * lists the person's installations and binds the one they pick.
 */
export function InstallModal(props: InstallModalProps) {
  const { api, org, open, onOpenChange, installationId, onInstalled } = props;
  const [phase, setPhase] = useState<InstallPhase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [watchRound, setWatchRound] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const popupRef = useRef<PopupHandle | null>(null);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;

  const installations = useAsync(
    () => (pickerOpen ? api.listUserInstallations() : Promise.resolve(null)),
    [pickerOpen, api],
  );

  // Watch the claim while there is one and the modal is open.
  useEffect(() => {
    if (!open || claimId === null) return;
    const stop = watchClaim({
      claimId,
      target: window,
      origin: window.location.origin,
      getClaim: () => api.getClaim({ org, claimId }),
      onOutcome: (o: ClaimOutcome) => {
        popupRef.current = null;
        if (o.kind === "completed") {
          if (o.installationId) installed.current(o.installationId);
          else
            setPhase({
              kind: "ended",
              message: "GitHub finished, but no installation came back. Try again.",
              canCheckAgain: false,
            });
        } else if (o.kind === "refused")
          setPhase({
            kind: "ended",
            message: o.reason ?? "The installation was refused.",
            canCheckAgain: false,
          });
        else if (o.kind === "expired")
          setPhase({
            kind: "ended",
            message: "The link expired. Start again.",
            canCheckAgain: false,
          });
        else
          setPhase({
            kind: "ended",
            message: "Still waiting for GitHub. If you finished there, check again.",
            canCheckAgain: true,
          });
      },
    });
    return stop;
  }, [open, claimId, watchRound, api, org]);

  const install = () => {
    setError(null);
    setPhase({ kind: "starting" });
    // The popup opens here, inside the click, before any await.
    beginInstall({
      open: () => {
        const w = window.open("about:blank", "turntable-install", "popup,width=760,height=820");
        return w as PopupHandle | null;
      },
      start: () =>
        api.startClaim({ org, popup: true, ...(installationId ? { installationId } : {}) }),
    }).then(
      (r) => {
        setClaimId(r.claimId);
        setWatchRound((n) => n + 1);
        if (r.blocked) setPhase({ kind: "blocked", url: r.url });
        else {
          popupRef.current = r.popup;
          setPhase({ kind: "waiting" });
        }
      },
      (e: unknown) => {
        setPhase({ kind: "idle" });
        setError(msg(e, "Could not start the installation."));
      },
    );
  };

  const pick = (id: string) => {
    setBindingId(id);
    setBindError(null);
    api.bindInstallation({ org, installationId: id }).then(
      () => {
        setBindingId(null);
        installed.current(id);
      },
      (e: unknown) => {
        setBindingId(null);
        setBindError(msg(e, "Could not connect that installation."));
      },
    );
  };

  const change = (o: boolean) => {
    if (!o) {
      popupRef.current?.close();
      popupRef.current = null;
      setClaimId(null);
      setPhase({ kind: "idle" });
    }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <InstallPanel
          configuring={Boolean(installationId)}
          phase={phase}
          error={error}
          onInstall={install}
          onCheckAgain={() => {
            setPhase({ kind: "waiting" });
            setWatchRound((n) => n + 1);
          }}
          picker={{
            open: pickerOpen,
            installations: installations.data,
            error: installations.error,
          }}
          onOpenPicker={() => setPickerOpen(true)}
          onPick={pick}
          bindingId={bindingId}
          bindError={bindError}
          onClose={() => change(false)}
          Title={DialogTitle}
          Description={DialogDescription}
        />
      </DialogContent>
    </Dialog>
  );
}
