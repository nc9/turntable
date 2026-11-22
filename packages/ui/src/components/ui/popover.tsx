import { Popover as P } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = "start",
  ...props
}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(
          "pop z-[60] w-64 rounded-lg border border-line bg-surface p-1 text-sm text-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]",
          className,
        )}
        {...props}
      />
    </P.Portal>
  );
}
