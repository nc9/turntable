import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
