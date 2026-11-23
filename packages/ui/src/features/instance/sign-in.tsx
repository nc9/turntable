import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { ApiError } from "@/api/http-adapter";
import { createInstanceApi } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connectInstance, useInstanceAuth } from "@/lib/instance-auth";

/**
 * A sign-in of its own for the instance administrator. It takes a `tti_` token only, checks it
 * with `instance_whoami`, and keeps it apart from any org session.
 */
export function InstanceSignIn() {
  const auth = useInstanceAuth();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createInstanceApi({ token: () => t }).whoami();
      connectInstance(t);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "Could not reach the server. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form
        className="w-full max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ShieldAlert className="size-5 text-dim" aria-hidden="true" />
          Instance administrator
        </h1>
        {auth.notice ? (
          <p
            role="status"
            className="mt-4 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3 text-sm"
          >
            {auth.notice}
          </p>
        ) : null}
        <p className="mb-5 mt-3 text-sm text-dim">
          This is a separate sign-in from your org. Paste an instance token (
          <code className="font-mono text-[13px] text-foreground">tti_...</code>), minted on the
          host with{" "}
          <code className="font-mono text-[13px] text-foreground">
            turntable token create --instance
          </code>
          . It stays in this tab only and is never sent to an org route.
        </p>
        <label htmlFor="instance-token" className="mb-1.5 block text-sm font-medium">
          Instance token
        </label>
        <Input
          id="instance-token"
          name="instance-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="tti_..."
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          required
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p role="alert" className="mt-3 text-sm text-st-failure">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="mt-5 w-full" disabled={busy}>
          {busy ? "Checking" : "Sign in as instance administrator"}
        </Button>
        <p className="mt-4 text-sm">
          <a href="/" className="text-dim underline">
            Back to org sign-in
          </a>
        </p>
      </form>
    </main>
  );
}
