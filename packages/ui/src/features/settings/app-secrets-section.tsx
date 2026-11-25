import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBackend } from "@/api";
import type { StepUpProof } from "@/api/types";
import { useWhoami } from "@/lib/directory";
import { signWithPasskey } from "@/lib/webauthn";

type Action = "instance_rotate_webhook_secret" | "instance_replace_app_private_key";

/**
 * Rotate the GitHub App's webhook secret and replace its private key without a shell. Shown to
 * an owner only; the server also refuses anyone who is not an owner of the org that owns the App,
 * and each action needs a passkey tap for exactly that request. The webhook secret is never shown: the
 * server pushes it to GitHub itself. The key file is read, sent and dropped.
 */
export function AppSecretsSection() {
  const { api } = getBackend();
  const who = useWhoami();
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ fingerprint: string; until: string } | null>(null);
  const [replaced, setReplaced] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (who.data?.role !== "owner") return null;

  async function confirm(action: Action, input: Record<string, unknown>): Promise<StepUpProof> {
    const c = await api.stepUpChallenge({ action, input });
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

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  const rotate = () =>
    guarded(async () => {
      const overlapMinutes = Number(minutes);
      const stepUp = await confirm("instance_rotate_webhook_secret", {
        overlap_minutes: overlapMinutes,
      });
      const r = await api.rotateWebhookSecret({ overlapMinutes, stepUp });
      setShown({ fingerprint: r.fingerprint, until: r.overlapUntil });
    });

  const upload = () =>
    guarded(async () => {
      const f = file.current?.files?.[0];
      if (!f) throw new Error("Choose the .pem file first.");
      const privateKey = await f.text();
      const stepUp = await confirm("instance_replace_app_private_key", {
        private_key: privateKey,
      });
      const r = await api.replaceAppPrivateKey({ privateKey, stepUp });
      if (file.current) file.current.value = "";
      setReplaced(r.fingerprint);
    });

  return (
    <section className="mt-8 space-y-4 rounded-xl border border-line p-4">
      <h2 className="text-base font-semibold">GitHub App secrets</h2>
      <p className="text-sm text-dim">
        For the org that owns the GitHub App. Each change needs a passkey tap. Neither value is ever
        shown.
      </p>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Webhook secret</h3>
        <p className="text-sm text-dim">
          Generates a new secret and updates it on GitHub for you. It is never shown. The old secret
          also works for the overlap, then stops.
        </p>
        <label htmlFor="overlap" className="block text-sm">
          Overlap in minutes (1 to 60)
        </label>
        <Input
          id="overlap"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <Button disabled={busy} onClick={() => void rotate()}>
          {busy ? "Working" : "Rotate webhook secret"}
        </Button>
        {shown ? (
          <RotatedNotice
            fingerprint={shown.fingerprint}
            until={shown.until}
            onDismiss={() => setShown(null)}
          />
        ) : null}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Private key</h3>
        <p className="text-sm text-dim">
          Generate a new key in the App&apos;s settings on GitHub, then upload the .pem. The server
          checks it with GitHub for the same App before it swaps; a key for another App is refused
          and the old key stays. Afterwards, delete the old key on GitHub.
        </p>
        <label htmlFor="pem" className="block text-sm">
          Private key file (.pem)
        </label>
        <input id="pem" ref={file} type="file" accept=".pem,application/x-pem-file,text/plain" />
        <Button disabled={busy} onClick={() => void upload()}>
          {busy ? "Working" : "Replace private key"}
        </Button>
        {replaced ? (
          <p role="status" className="text-sm">
            Replaced. New key fingerprint {replaced}. Delete the old key on GitHub.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-st-failed">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** What an owner sees after a rotation: no secret, only that GitHub was updated. */
export function RotatedNotice(props: {
  fingerprint: string;
  until: string;
  onDismiss: () => void;
}) {
  return (
    <div role="status" className="rounded-lg border border-line p-3 text-sm">
      <p>Rotated; GitHub&apos;s webhook secret was updated.</p>
      <p className="mt-2 text-dim">
        Fingerprint {props.fingerprint}. The old secret works until {props.until}.
      </p>
      <Button variant="ghost" onClick={props.onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
