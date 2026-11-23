import type { JobAttempt } from "@/api/types";
import { formatDuration } from "@/lib/format";
import { sandboxInfo } from "@/lib/sandbox";

const tf = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Sandbox created and destroyed times and exact sandbox time for each attempt of a job. */
export function SandboxTimes({ attempts, now }: { attempts: JobAttempt[]; now: number }) {
  const rows = attempts.flatMap((a) => {
    const info = sandboxInfo(a, now);
    return info ? [{ a, info }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <ul className="m-0 w-full list-none space-y-0.5 pl-[30px] text-xs text-dim">
      {rows.map(({ a, info }) => (
        <li key={a.id} className="flex flex-wrap items-center gap-x-2">
          <span>Attempt {a.attempt} sandbox</span>
          <span className="tabular text-foreground">
            {info.estimated ? "about " : ""}
            {formatDuration(info.seconds * 1000)}
          </span>
          {info.estimated ? (
            <span
              title="The provider has not confirmed the destroy, so this runs to the attempt's end (or now) and may be off."
              className="rounded border border-line px-1 text-[11px]"
            >
              estimated
            </span>
          ) : null}
          <span className="tabular">
            created {tf.format(info.createdAt)}
            {info.destroyedAt !== null ? `, destroyed ${tf.format(info.destroyedAt)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
