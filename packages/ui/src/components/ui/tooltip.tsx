import { Tooltip as T } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={300}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: ReactNode;
  children: ReactNode;
  side?: ComponentProps<typeof T.Content>["side"];
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cn(
            "pop z-[70] max-w-xs rounded-md bg-foreground px-2 py-1 text-xs text-background",
          )}
        >
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
