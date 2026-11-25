import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { DispatchedRun, DispatchInput } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getOnboardingApi } from "@/features/onboarding/api";
import {
  type DispatchWorkflow,
  dispatchWorkflows,
  initialInputs,
  validateDispatch,
} from "@/lib/dispatch-form";
import { RunLink } from "./common";

const FIELD =
  "mt-1.5 h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export type DispatchRequest = { workflow: string; ref: string; inputs: Record<string, string> };

function InputField({
  decl,
  value,
  error,
  onChange,
}: {
  decl: DispatchInput;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  const id = `dispatch-input-${decl.name}`;
  const label = (
    <label htmlFor={id} className="text-sm font-medium">
      {decl.name}
      {decl.required ? <span aria-hidden="true"> *</span> : null}
    </label>
  );
  const hint = decl.description ? (
    <p className="mt-0.5 text-xs text-dim">{decl.description}</p>
  ) : null;
  const err = error ? (
    <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-st-failure">
      {error}
    </p>
  ) : null;
  const aria = {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  };
  if (decl.type === "boolean")
    return (
      <div className="mt-4">
        <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
          <input
            id={id}
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          />
          {decl.name}
        </label>
        {hint}
      </div>
    );
  return (
    <div className="mt-4">
      {label}
      {hint}
      {decl.type === "choice" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={FIELD}
          {...aria}
        >
          {decl.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          value={value}
          inputMode={decl.type === "number" ? "decimal" : "text"}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          className="mt-1.5"
          {...aria}
        />
      )}
      {err}
    </div>
  );
}

/** The form itself, with no network: the dialog feeds it workflows and a submit handler. */
export function DispatchForm({
  workflows,
  defaultBranch,
  busy,
  error,
  onSubmit,
}: {
  workflows: DispatchWorkflow[];
  defaultBranch: string;
  busy: boolean;
  error: string | null;
  onSubmit: (req: DispatchRequest) => void;
}) {
  const [path, setPath] = useState(workflows[0]?.path ?? "");
  const wf = workflows.find((w) => w.path === path) ?? workflows[0];
  const [ref, setRef] = useState(defaultBranch);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialInputs(wf?.dispatch_inputs ?? []),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!wf)
    return <p className="mt-4 text-sm text-dim">No workflow here declares workflow_dispatch.</p>;
  const submit = () => {
    const found = validateDispatch(wf.dispatch_inputs, ref, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onSubmit({ workflow: wf.path, ref: ref.trim(), inputs: values });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="mt-4">
        <label htmlFor="dispatch-workflow" className="text-sm font-medium">
          Workflow
        </label>
        <select
          id="dispatch-workflow"
          value={wf.path}
          onChange={(e) => {
            const next = workflows.find((w) => w.path === e.target.value);
            setPath(e.target.value);
            setValues(initialInputs(next?.dispatch_inputs ?? []));
            setErrors({});
          }}
          className={FIELD}
        >
          {workflows.map((w) => (
            <option key={w.path} value={w.path}>
              {w.name ?? w.path}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-4">
        <label htmlFor="dispatch-ref" className="text-sm font-medium">
          Branch or tag
        </label>
        <Input
          id="dispatch-ref"
          value={ref}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setRef(e.target.value)}
          className="mt-1.5"
          aria-invalid={errors.ref ? true : undefined}
        />
        {errors.ref ? (
          <p role="alert" className="mt-1 text-xs text-st-failure">
            {errors.ref}
          </p>
        ) : null}
      </div>
      {wf.dispatch_inputs.map((d) => (
        <InputField
          key={`${wf.path}:${d.name}`}
          decl={d}
          value={values[d.name] ?? ""}
          error={errors[d.name]}
          onChange={(v) => setValues((cur) => ({ ...cur, [d.name]: v }))}
        />
      ))}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-st-failure">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button type="submit" size="sm" disabled={busy}>
          <Play />
          {busy ? "Starting" : "Run"}
        </Button>
      </div>
    </form>
  );
}

/** "Run workflow" on the project page: lists the dispatch-capable workflows, then starts one. */
export function RunWorkflowButton({ org, project }: { org: string; project: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Play />
        Run workflow
      </Button>
      {open ? (
        <RunWorkflowDialog org={org} project={project} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function RunWorkflowDialog({
  org,
  project,
  onClose,
}: {
  org: string;
  project: string;
  onClose: () => void;
}) {
  const api = getOnboardingApi();
  const [loaded, setLoaded] = useState<{ workflows: DispatchWorkflow[]; branch: string } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<DispatchedRun | null>(null);
  useEffect(() => {
    api.previewWorkflows({ org, project }).then(
      (p) =>
        setLoaded({
          workflows: dispatchWorkflows(p.workflows),
          branch: p.default_branch ?? "main",
        }),
      (e: unknown) =>
        setLoadError(e instanceof Error ? e.message : "Could not read the workflows."),
    );
  }, [api, org, project]);
  const send = (req: DispatchRequest) => {
    setBusy(true);
    setError(null);
    api.runDispatch({ org, project, ...req }).then(
      (r) => {
        setRun(r);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : "Could not start the run.");
        setBusy(false);
      },
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-5">
        <DialogTitle className="text-base font-semibold">Run workflow</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-dim">
          Start a workflow that declares workflow_dispatch. A release tag still waits for approval.
        </DialogDescription>
        {run ? (
          <div className="mt-4 text-sm" role="status">
            <p>
              {run.state === "awaiting_approval"
                ? "Run created and waiting for approval."
                : "Run started."}
            </p>
            <RunLink
              orgSlug={org}
              projectSlug={project}
              runId={run.run_id}
              className="mt-2 inline-block text-accent underline"
            >
              View run
            </RunLink>
          </div>
        ) : loadError ? (
          <p role="alert" className="mt-4 text-sm text-st-failure">
            {loadError}
          </p>
        ) : loaded ? (
          <DispatchForm
            workflows={loaded.workflows}
            defaultBranch={loaded.branch}
            busy={busy}
            error={error}
            onSubmit={send}
          />
        ) : (
          <p role="status" className="mt-4 text-sm text-dim">
            Reading the workflows
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
