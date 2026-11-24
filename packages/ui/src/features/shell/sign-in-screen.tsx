import { KeyRound } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LOGIN_PATH, TOKEN_SIGN_IN_PATH, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

function GithubGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * The landing page for every logged-out visit (#477). "Sign in with GitHub" is a plain link: the
 * server starts the OAuth round trip and brings the person back to `/`. The API token form is a
 * small secondary link for agents, scripts and break-glass use.
 */
export function SignInScreen() {
  const session = useSession();
  const auth = useAuth();
  const notice = session.notice ?? auth.notice;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12" />
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Turntable</h1>
          <p className="text-sm text-dim">Use the GitHub account an org admin invited.</p>
        </div>
        {notice ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3 text-sm text-foreground"
          >
            {notice}
          </p>
        ) : null}
        <a
          href={LOGIN_PATH}
          className={cn(buttonVariants({ variant: "default" }), "h-10 w-full text-sm")}
        >
          <GithubGlyph />
          Sign in with GitHub
        </a>
        <p className="mt-6 text-center text-[13px] text-faint">
          <a
            href={TOKEN_SIGN_IN_PATH}
            className="inline-flex items-center gap-1.5 rounded px-1 underline-offset-4 hover:text-foreground hover:underline"
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            Use an API token
          </a>
        </p>
      </div>
    </main>
  );
}
