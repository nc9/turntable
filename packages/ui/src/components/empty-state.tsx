import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-lg border border-line bg-subtle text-dim [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <div className="max-w-sm">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {children ? <p className="mt-1 text-sm text-dim">{children}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      title={title}
      action={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="h-8 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium transition-transform duration-150 hover:bg-muted active:scale-[0.97]"
          >
            Try again
          </button>
        ) : null
      }
    >
      {message}
    </EmptyState>
  );
}
