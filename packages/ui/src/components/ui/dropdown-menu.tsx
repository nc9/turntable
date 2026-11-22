import { DropdownMenu as D } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = D.Root;
export const DropdownMenuTrigger = D.Trigger;
export const DropdownMenuGroup = D.Group;
export const DropdownMenuRadioGroup = D.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "pop z-[60] max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 overflow-y-auto rounded-lg border border-line bg-surface p-1 text-sm text-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]",
          className,
        )}
        {...props}
      />
    </D.Portal>
  );
}

const itemClass =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-dim";

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof D.Item>) {
  return <D.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof D.RadioItem>) {
  return (
    <D.RadioItem className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <D.ItemIndicator className="absolute right-2 text-accent">
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </D.ItemIndicator>
    </D.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof D.Label>) {
  return <D.Label className={cn("px-2 py-1.5 text-xs text-faint", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof D.Separator>) {
  return <D.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}
