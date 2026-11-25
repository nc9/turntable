// Removing a project, from its settings page: unbind the repo and keep every run, or (owner, with
// a passkey) delete the project and its history for good.
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { OnboardingApi } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { getOnboardingApi } from "@/features/onboarding/api";
import { resetDirectory } from "@/lib/directory";
import { meetsRole, type Role } from "@/lib/roles";
import { CeremonyError, signWithPasskey } from "@/lib/webauthn";

export function RemoveProjectPanel({
  project,
  busy,
  error,
  done,
  role,
  confirmDelete,
  onConfirmDelete,
  onRemove,
  onDelete,
}: {
  project: string;
  busy: boolean;
  error: string | null;
  done: string | null;
  /** The caller's role; deleting history is shown to owners only (the server enforces it). */
  role: Role | null;
  confirmDelete: boolean;
  onConfirmDelete: (on: boolean) => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  const owner = role !== null && meetsRole(role, "owner");
  return (
    <section className="mt-8 space-y-4" aria-label="Remove project">
      <h2 className="text-sm font-semibold">Remove project</h2>
      <div className="space-y-2 rounded-xl border border-line p-4">
        <p className="text-sm text-dim">
          Unbinds the repository from <span className="font-mono">{project}</span>. Nothing is
          ingested for it any more. Its runs, logs and settings are kept, and you can add the
          repository again later.
        </p>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onRemove}>
          Remove, keep history
        </Button>
      </div>
      {owner ? (
        <div className="space-y-2 rounded-xl border border-line p-4">
          <p className="text-sm text-dim">
            Deletes the project and all of its history: runs, logs, artifacts, tokens and secrets
            scoped to it. This cannot be undone. A passkey confirms it.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmDelete}
              onChange={(e) => onConfirmDelete(e.target.checked)}
              aria-label={`I understand that all history of ${project} is deleted`}
            />
            I understand that all history of <span className="font-mono">{project}</span> is deleted
          </label>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy || !confirmDelete}
            onClick={onDelete}
          >
            Delete project and history
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-dim">
          {done}
        </p>
      ) : null}
    </section>
  );
}

async function confirmWithPasskey(api: OnboardingApi, org: string, project: string) {
  const c = await api.removeProjectChallenge({ org, project });
  const key = c.passkeys[0];
  if (!key) throw new Error("No passkey of yours is enrolled to confirm this.");
  const sig = await signWithPasskey({
    challenge: c.challenge,
    rpId: c.rpId,
    passkeyId: key.passkeyId,
  });
  return {
    id: c.id,
    approver: key.approver,
    signature: {
      credential_id: sig.credential_id,
      client_data_json: sig.client_data_json,
      authenticator_data: sig.authenticator_data,
      signature: sig.signature,
    },
  };
}

export function RemoveProject({
  org,
  project,
  role,
}: {
  org: string;
  project: string;
  role: Role | null;
}) {
  const api = getOnboardingApi();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = async (deleteHistory: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const stepUp = deleteHistory ? await confirmWithPasskey(api, org, project) : undefined;
      const r = await api.removeProject({
        org,
        project,
        ...(deleteHistory ? { deleteHistory: true } : {}),
        ...(stepUp ? { stepUp } : {}),
      });
      resetDirectory();
      if (r.deleted) {
        void navigate({ to: "/$org", params: { org } });
        return;
      }
      setDone("The repository is unbound. The project and its history are kept.");
    } catch (e) {
      setError(
        e instanceof CeremonyError || e instanceof Error
          ? e.message
          : "Could not remove the project.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <RemoveProjectPanel
      project={project}
      busy={busy}
      error={error}
      done={done}
      role={role}
      confirmDelete={confirmDelete}
      onConfirmDelete={setConfirmDelete}
      onRemove={() => void run(false)}
      onDelete={() => void run(true)}
    />
  );
}
