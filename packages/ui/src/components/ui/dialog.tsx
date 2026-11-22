import { Dialog as D } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogTitle = D.Title;
export const DialogDescription = D.Description;

export function DialogContent({
  className,
  overlayClassName,
  ...props
}: ComponentProps<typeof D.Content> & { overlayClassName?: string }) {
  return (
    <D.Portal>
      <D.Overlay className={cn("overlay-in fixed inset-0 z-50 bg-overlay", overlayClassName)} />
      <D.Content
        className={cn(
          "dialog-in fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface shadow-[0_16px_60px_rgb(0_0_0/0.25)]",
          className,
        )}
        {...props}
      />
    </D.Portal>
  );
}

/** Left-edge drawer used for the mobile navigation. */
export function SheetContent({ className, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Overlay className="overlay-in fixed inset-0 z-50 bg-overlay" />
      <D.Content
        className={cn(
          "sheet-in fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
          className,
        )}
        {...props}
      />
    </D.Portal>
  );
}
