import { useState, useSyncExternalStore } from "react";
import {
  avatarsVersion,
  initialsOf,
  orgIcon,
  projectIcon,
  safeAvatarUrl,
  subscribeAvatars,
} from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * A round (or, for orgs and projects, rounded-square) icon: the GitHub avatar when there is one
 * and it loads, else initials. The name is text, never markup. The image is decorative (the
 * name sits beside it), so it has an empty alt.
 */
export function Avatar({
  src,
  name,
  square = false,
  className,
}: {
  src: string | null | undefined;
  name: string | null | undefined;
  square?: boolean;
  className?: string;
}) {
  const url = safeAvatarUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  const shape = square ? "rounded-md" : "rounded-full";
  const base = cn(
    "inline-flex size-5 shrink-0 items-center justify-center overflow-hidden bg-muted text-[9px] font-semibold leading-none text-dim",
    shape,
    className,
  );
  if (url && failed !== url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        data-avatar="image"
        onError={() => setFailed(url)}
        className={cn(base, "object-cover")}
      />
    );
  }
  return (
    <span aria-hidden="true" data-avatar="initials" className={base}>
      {initialsOf(name)}
    </span>
  );
}

function useAvatarVersion(): number {
  return useSyncExternalStore(subscribeAvatars, avatarsVersion, avatarsVersion);
}

/** An org's icon, from what the feed has learned; initials until then. */
export function OrgAvatar({
  slug,
  name,
  className,
}: {
  slug: string;
  name?: string;
  className?: string;
}) {
  useAvatarVersion();
  return (
    <Avatar src={orgIcon(slug)} name={name ?? slug} square {...(className ? { className } : {})} />
  );
}

export function ProjectAvatar({
  org,
  slug,
  name,
  className,
}: {
  org: string;
  slug: string;
  name?: string;
  className?: string;
}) {
  useAvatarVersion();
  return (
    <Avatar
      src={projectIcon(org, slug) ?? orgIcon(org)}
      name={name ?? slug}
      square
      {...(className ? { className } : {})}
    />
  );
}
