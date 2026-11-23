import { KeyRound } from "lucide-react";
import { useState } from "react";
import { ApiError, createHttpApi } from "@/api/http-adapter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connect, useAuth } from "@/lib/auth";
import { resetDirectory } from "@/lib/directory";

/**
 * Temporary sign-in until session auth (#13): paste an agent token (`turntable token create`).
 * It is checked with one cheap request, kept in memory and sessionStorage, and never put in a URL.
 */
export function ConnectScreen() {
  const auth = useAuth();
  const [token, setToken] = useState("");
  const [org, setOrg] = useState(auth.org ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const t = token.trim();
    const o = org.trim();
    if (!t || !o || busy) return;
    setBusy(true);
    setError(null);
    try {
      const probe = createHttpApi({ org: () => o, token: () => t });
      await probe.listRuns({ projectId: "", limit: 1 });
      resetDirectory();
      connect(t, o);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.status === 401
            ? "The server did not accept that token. Check it and the org, or create a new one."
            : e.status === 404
              ? "No org with that slug in this token's scope."
              : e.message
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
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="mb-6 flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
            <rect width="32" height="32" rx="7" className="fill-foreground" />
            <circle
              cx="16"
              cy="16"
              r="9"
              fill="none"
              className="stroke-background"
              strokeWidth="2.5"
            />
            <circle cx="16" cy="16" r="2.5" className="fill-background" />
          </svg>
          <h1 className="text-xl font-semibold tracking-tight">Connect to Turntable</h1>
        </div>
        {auth.notice ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3 text-sm text-foreground"
          >
            {auth.notice}
          </p>
        ) : null}
        <p className="mb-5 text-sm text-dim">
          Paste an agent token. Create one with{" "}
          <code className="font-mono text-[13px] text-foreground">turntable token create</code>. It
          stays in this tab only and is never put in a URL.
        </p>
        <label htmlFor="connect-org" className="mb-1.5 block text-sm font-medium">
          Org
        </label>
        <Input
          id="connect-org"
          name="org"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          placeholder="your-org"
          autoComplete="organization"
          spellCheck={false}
          autoCapitalize="none"
          required
          className="mb-4"
        />
        <label htmlFor="connect-token" className="mb-1.5 block text-sm font-medium">
          Token
        </label>
        <Input
          id="connect-token"
          name="token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="tt_..."
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          required
          aria-describedby={error ? "connect-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p id="connect-error" role="alert" className="mt-3 text-sm text-st-failure">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          className="mt-5 w-full"
          disabled={busy}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          <KeyRound />
          {busy ? "Connecting" : "Connect"}
        </Button>
      </form>
    </main>
  );
}
