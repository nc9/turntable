import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The Turntable mark: the record with a tonearm, the same glyph as `favicon.svg`, inlined so it
 * follows the theme (strict CSP: no external image needed).
 */
export function BrandMark({ className }: { className?: string }) {
  const mask = useId();
  return (
    <svg viewBox="0 0 512 512" className={cn("size-8", className)} aria-hidden="true">
      <rect width="512" height="512" rx="112" className="fill-foreground" />
      <g transform="translate(256 256) scale(0.8) translate(-265 -245)">
        <defs>
          <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <rect width="512" height="512" fill="#fff" />
            <circle cx="236" cy="276" r="54" fill="#000" />
            <circle cx="236" cy="276" r="18" fill="#fff" />
            <path
              d="M412 96V204L350 266"
              fill="none"
              stroke="#000"
              strokeWidth="74"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </mask>
        </defs>
        <circle cx="236" cy="276" r="150" className="fill-background" mask={`url(#${mask})`} />
        <path
          d="M412 96V204L350 266"
          fill="none"
          className="stroke-background"
          strokeWidth="32"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="412" cy="96" r="32" className="fill-background" />
      </g>
    </svg>
  );
}
