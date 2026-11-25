import { Lock, TriangleAlert } from "lucide-react";
import type { Setting } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  draftOf,
  editability,
  formatValue,
  kindOf,
  lockNote,
  pickable,
  SOURCE_LABEL,
} from "@/lib/settings";
import type { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";

export type SettingsPanelProps = {
  settings: Setting[];
  /** The caller's role; null until it is known. The server enforces it either way. */
  role: Role | null;
  /** Unsaved text by key. */
  drafts: Record<string, string>;
  /** The server's refusal by key, shown verbatim. */
  errors: Record<string, string>;
  /** The key being saved, if any. */
  busy: string | null;
  onDraft: (key: string, text: string) => void;
  onSave: (s: Setting) => void;
  onReset: (s: Setting) => void;
};

const BADGE: Record<Setting["source"], string> = {
  env: "border-st-running/40 bg-st-running-bg text-st-running",
  toml: "border-st-approval/40 bg-st-approval-bg text-st-approval",
  db: "border-st-success/40 bg-st-success-bg text-st-success",
  default: "border-line bg-subtle text-dim",
};

export function SourceBadge({ source }: { source: Setting["source"] }) {
  return (
    <span
      data-source={source}
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 font-mono text-[11px]",
        BADGE[source],
      )}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

function Editor({
  s,
  value,
  disabled,
  onChange,
}: {
  s: Setting;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const id = `setting-${s.key}`;
  if (s.strictness)
    return (
      <select
        id={id}
        aria-label={s.key}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm disabled:opacity-50"
      >
        {s.strictness.map((v) => (
          <option key={v} value={v} disabled={!pickable(s, v)}>
            {v}
          </option>
        ))}
      </select>
    );
  if (kindOf(s) === "boolean")
    return (
      <select
        id={id}
        aria-label={s.key}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm disabled:opacity-50"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  return (
    <Input
      id={id}
      aria-label={s.key}
      className="font-mono text-[13px]"
      value={value}
      disabled={disabled}
      inputMode={kindOf(s) === "number" ? "numeric" : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Row({ s, p }: { s: Setting; p: SettingsPanelProps }) {
  const { editable, reason } = editability(p.role, s);
  const lock = lockNote(s);
  const current = draftOf(s.value);
  const draft = p.drafts[s.key] ?? current;
  const dirty = draft !== current;
  const saving = p.busy === s.key;
  const error = p.errors[s.key];
  return (
    <li className="px-4 py-3.5 text-sm" data-setting={s.key}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <label htmlFor={`setting-${s.key}`} className="font-mono text-[13px] font-medium">
          {s.key}
        </label>
        <SourceBadge source={s.source} />
        {lock ? (
          <span className="inline-flex items-center gap-1 text-xs text-dim">
            <Lock className="size-3" aria-hidden="true" />
            {lock}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-dim">{s.description}</p>
      {s.warning ? (
        <p
          data-warning={s.key}
          className="mt-1.5 inline-flex items-start gap-1.5 text-[13px] font-medium text-st-approval"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {s.warning}
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="w-full max-w-xs">
          <Editor
            s={s}
            value={draft}
            disabled={!editable || saving}
            onChange={(t) => p.onDraft(s.key, t)}
          />
        </div>
        {editable && dirty ? (
          <Button size="sm" disabled={saving} onClick={() => p.onSave(s)}>
            {saving ? "Saving" : "Save"}
          </Button>
        ) : null}
        {editable && s.source === "db" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving || !pickable(s, s.default)}
            title={
              !pickable(s, s.default)
                ? "Only the instance administrator can loosen this setting."
                : undefined
            }
            onClick={() => p.onReset(s)}
          >
            Reset to default
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 text-xs text-faint">
        Default <span className="font-mono">{formatValue(s.default)}</span>
        {s.source === "default" ? "" : ` · effective ${formatValue(s.value)}`}
      </p>
      {editable && s.trust === "tighten_only" ? (
        <p data-trust={s.key} className="mt-1 text-xs text-dim">
          Tightening saves at once. Loosening asks you to confirm with your passkey.
        </p>
      ) : null}
      {reason ? <p className="mt-1 text-xs text-dim">{reason}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] font-medium text-st-failure">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** One row per setting the server listed: nothing here is written by hand per setting. */
export function SettingsPanel(p: SettingsPanelProps) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {p.settings.map((s) => (
        <Row key={s.key} s={s} p={p} />
      ))}
    </ul>
  );
}
