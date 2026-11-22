import { Toggle as T } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Pressed-state button for toolbar options such as follow, wrap and timestamps. */
export function Toggle({ className, ...props }: ComponentProps<typeof T.Root>) {
  return (
    <T.Root
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-dim transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] data-[state=on]:bg-muted data-[state=on]:text-foreground [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}
