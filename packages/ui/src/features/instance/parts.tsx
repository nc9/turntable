import type { ReactNode } from "react";
import { getInstanceApi } from "@/api/instance";
import { Input } from "@/components/ui/input";
import { sanitize } from "@/log/parser";
import { useAsync } from "@/lib/use-async";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children ? <p className="mt-0.5 text-sm text-dim">{children}</p> : null}
    </>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">{children}</div>;
}

/** The server's refusal, word for word. */
export function Refusal({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="mt-2 text-[13px] font-medium text-st-failure">
      {message}
    </p>
  ) : null;
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-dim">{hint}</p> : null}
    </div>
  );
}

export function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  mono?: boolean;
  list?: string;
}) {
  return (
    <Field id={props.id} label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <Input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        list={props.list}
        className={props.mono ? "font-mono text-[13px]" : undefined}
      />
    </Field>
  );
}

/** The orgs of the instance, from `instance_list_orgs`. Names are the orgs' own: untrusted text. */
export function OrgSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (slug: string) => void;
  id: string;
}) {
  const orgs = useAsync(() => getInstanceApi().listOrgs(), []);
  return (
    <Field id={id} label="Org">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm"
      >
        <option value="">Choose an org</option>
        {(orgs.data ?? []).map((o) => (
          <option key={o.slug} value={o.slug}>
            {sanitize(o.name)} ({o.slug})
          </option>
        ))}
      </select>
      <Refusal message={orgs.error} />
    </Field>
  );
}
