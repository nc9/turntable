import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { clearRotated, connectInstance } from "@/lib/instance-auth";

/**
 * Shown once after `rotate_instance_token`. The secret exists only here, in memory: it is not
 * stored, and it is gone when this screen is left.
 */
export function RotatedNotice({ secret }: { secret: string }) {
  const [copied, setCopied] = useState<"yes" | "blocked" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("yes");
    } catch {
      setCopied("blocked");
    }
  }
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="w-full max-w-lg" aria-labelledby="rotated-title">
        <h1 id="rotated-title" className="text-xl font-semibold tracking-tight">
          New instance token
        </h1>
        <p
          role="alert"
          className="mt-3 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3 text-sm"
        >
          This is the only time the secret is shown. The old token is revoked, so this session must
          sign in with the new one. Keep it somewhere safe before you continue.
        </p>
        <code
          data-secret
          className="mt-4 block break-all rounded-md border border-line-strong bg-surface p-3 font-mono text-[13px]"
        >
          {secret}
        </code>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void copy()}>
            {copied === "yes" ? <Check /> : <Copy />}
            {copied === "yes" ? "Copied" : "Copy"}
          </Button>
          <Button onClick={() => connectInstance(secret)}>Sign in with the new token</Button>
          <Button variant="ghost" onClick={clearRotated}>
            I have saved it
          </Button>
        </div>
        {copied === "blocked" ? (
          <p role="status" className="mt-2 text-sm text-dim">
            Copy was blocked by the browser. Select the secret and copy it instead.
          </p>
        ) : null}
      </section>
    </main>
  );
}
