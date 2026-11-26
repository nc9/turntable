import { useEffect, useState } from "react";
import { getInstanceApi, type NetworkStatus } from "@/api/instance";
import { sanitize } from "@/log/parser";

const POLL_MS = 15_000;

const when = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/** The network state and the recent degraded windows. Presentational, so a test can render it. */
export function NetworkView({ status }: { status: NetworkStatus }) {
  const degraded = status.state === "degraded";
  return (
    <section
      aria-label="Network"
      data-network={status.state}
      className={`border-b px-4 py-2 text-xs ${degraded ? "border-st-failure/40 bg-st-failure-bg text-st-failure" : "border-line text-dim"}`}
    >
      <p role="status">
        {degraded
          ? `Network degraded since ${status.since ? when(status.since) : "boot"} UTC: no new attempt starts and check posts wait.`
          : "Network healthy."}
      </p>
      {status.targets.length > 0 ? (
        <ul aria-label="Last probe" className="mt-1 flex flex-wrap gap-x-4 font-mono">
          {status.targets.map((t) => (
            <li key={t.target}>
              {sanitize(t.target)}:{" "}
              {t.ok ? `ok (${t.httpMs ?? 0} ms)` : sanitize(t.error ?? "failed")}
            </li>
          ))}
        </ul>
      ) : null}
      {status.windows.length > 0 ? (
        <ul aria-label="Degraded windows" className="mt-1 font-mono">
          {status.windows.map((w) => (
            <li key={w.start}>
              {when(w.start)} to {w.end ? when(w.end) : "now (still degraded)"}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Polls the instance network state while the shell is open. */
export function NetworkStatusBar() {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      getInstanceApi()
        .networkStatus()
        .then((s) => live && setStatus(s))
        .catch(() => {});
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return status ? <NetworkView status={status} /> : null;
}
