import { useEffect, useSyncExternalStore, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  UI_SHA,
  UI_VERSION,
  displayVersion,
  startVersionWatch,
  watcher,
} from "@/lib/build-version";

/** The banner's view. `version` is the server's full version string. */
export function UpdateBannerView(props: {
  version: string;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") props.onDismiss();
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {/* Escape on a focused banner dismisses it; the buttons are the real controls. */}
      <div
        role="status"
        aria-live="polite"
        onKeyDown={onKeyDown}
        className="pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-line-strong bg-surface px-4 py-3 text-sm shadow-lg"
      >
        <p className="text-foreground">
          A new version of Turntable is available{" "}
          <span className="text-dim">{displayVersion(props.version)}</span>
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={props.onRefresh}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onDismiss}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in main.tsx. Never reloads by itself: Refresh is the person's choice. */
export function UpdateBanner() {
  const version = useSyncExternalStore(watcher.subscribe, watcher.pending, watcher.pending);
  useEffect(() => startVersionWatch(), []);
  if (version === null) return null;
  return (
    <UpdateBannerView
      version={version}
      onRefresh={() => window.location.reload()}
      onDismiss={() => watcher.dismiss()}
    />
  );
}

/** "Turntable 0.1.0-dev7" with the full string and sha on hover. Empty in a dev build. */
export function BuildVersionLabel(props: { version?: string; sha?: string; className?: string }) {
  const version = props.version ?? UI_VERSION;
  const sha = props.sha ?? UI_SHA;
  if (version === "") return null;
  return (
    <span
      className={props.className ?? "block px-3 py-2 text-xs text-dim"}
      title={`${version}${sha ? `, sha ${sha}` : ""}`}
    >
      Turntable {displayVersion(version)}
    </span>
  );
}
