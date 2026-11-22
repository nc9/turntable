import { Command as C } from "cmdk";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function CommandRoot({ className, ...props }: ComponentProps<typeof C>) {
  return <C className={cn("flex h-full w-full flex-col overflow-hidden", className)} {...props} />;
}

export function CommandInput({ className, ...props }: ComponentProps<typeof C.Input>) {
  return (
    <C.Input
      className={cn(
        "h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-foreground outline-none placeholder:text-faint",
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof C.List>) {
  return (
    <C.List
      className={cn("max-h-80 overflow-y-auto overscroll-contain p-2", className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof C.Empty>) {
  return <C.Empty className="px-3 py-8 text-center text-sm text-dim" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof C.Group>) {
  return (
    <C.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof C.Item>) {
  return (
    <C.Item
      className={cn(
        "flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-foreground data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-dim",
        className,
      )}
      {...props}
    />
  );
}
