import { useRef, useState } from "react";
import { getInstanceApi } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page, PageHeader, Refusal } from "./parts";
import { useAction } from "./use-action";

/**
 * Rotate the GitHub App's webhook secret and replace its private key, without a shell. Each takes
 * a passkey tap (the signed-in person's own, in the operator org). The new webhook secret is held
 * in this component's state only until the person leaves or dismisses it; the key file is read,
 * sent and dropped, and never shown.
 */
export function InstanceAppSecretsPage() {
  const api = getInstanceApi();
  const [minutes, setMinutes] = useState("60");
  const [shown, setShown] = useState<{ secret: string; fingerprint: string; until: number } | null>(
    null,
  );
  const [replaced, setReplaced] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const rotate = useAction(() => api.rotateWebhookSecret({ overlapMinutes: Number(minutes) }));
  const replace = useAction(async (pem: string) => api.replaceAppPrivateKey({ privateKey: pem }));

  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) return;
    const pem = await f.text();
    const r = await replace.run(pem);
    if (file.current) file.current.value = "";
    if (r) setReplaced(r.fingerprint);
  }

  return (
    <Page>
      <PageHeader title="GitHub App secrets">
        Both changes need a passkey tap from a signed-in administrator with a passkey in the
        operator org. Neither value is shown again after this page.
      </PageHeader>

      <section className="mt-6 space-y-3 rounded-xl border border-line p-4">
        <h2 className="text-sm font-semibold">Webhook secret</h2>
        <p className="text-sm text-dim">
          Generates a new secret and shows it once. Paste it into the App&apos;s webhook settings on
          GitHub. The old secret also works for the overlap you choose, then stops.
        </p>
        <label htmlFor="overlap" className="block text-sm font-medium">
          Overlap in minutes (1 to 60)
        </label>
        <Input
          id="overlap"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
        <Button
          disabled={rotate.busy}
          onClick={() =>
            void rotate
              .run()
              .then(
                (r) =>
                  r &&
                  setShown({ secret: r.secret, fingerprint: r.fingerprint, until: r.overlapUntil }),
              )
          }
        >
          {rotate.busy ? "Waiting for your passkey" : "Rotate webhook secret"}
        </Button>
        <Refusal message={rotate.error} />
        {shown ? (
          <div role="status" className="rounded-lg border border-line p-3 text-sm">
            <p>Copy this now. It is not shown again.</p>
            <code className="mt-2 block break-all font-mono text-[13px]">{shown.secret}</code>
            <p className="mt-2 text-dim">
              Fingerprint {shown.fingerprint}. The old secret works until{" "}
              {new Date(shown.until).toLocaleString()}.
            </p>
            <Button variant="ghost" onClick={() => setShown(null)}>
              Done, hide it
            </Button>
          </div>
        ) : null}
      </section>

      <section className="mt-6 space-y-3 rounded-xl border border-line p-4">
        <h2 className="text-sm font-semibold">Private key</h2>
        <p className="text-sm text-dim">
          Generate a new key in the App&apos;s settings on GitHub, then upload the .pem here. The
          server checks it against GitHub for the same App before it swaps. A key for another App is
          refused and the old key stays. Afterwards, delete the old key on GitHub.
        </p>
        <label htmlFor="pem" className="block text-sm font-medium">
          Private key file (.pem)
        </label>
        <input id="pem" ref={file} type="file" accept=".pem,application/x-pem-file,text/plain" />
        <Button disabled={replace.busy} onClick={() => void upload()}>
          {replace.busy ? "Waiting for your passkey" : "Replace private key"}
        </Button>
        <Refusal message={replace.error} />
        {replaced ? (
          <p role="status" className="text-sm">
            Replaced. New key fingerprint {replaced}. Delete the old key in the App&apos;s settings
            on GitHub.
          </p>
        ) : null}
      </section>
    </Page>
  );
}
