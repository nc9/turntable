// Instance "Release lane" settings (#541): visible only to owners of the operator org. Every write
// runs the passkey step-up first (src/lib/release-lane.ts). The secret form is write-only: its
// value is held in this component only until the call is made, then cleared, never shown again.
import { useState, type ReactNode } from "react";
import { getBackend } from "@/api";
import type { LaneAction, LaneConfig, LaneKey, LaneSecretStatus } from "@/api/types";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useWhoami } from "@/lib/directory";
import {
  canConfigureLane,
  fingerprintOf,
  runLaneWrite,
  signingInput,
  targetInput,
} from "@/lib/release-lane";
import { signWithPasskey } from "@/lib/webauthn";

const field = "flex flex-col gap-1 text-xs text-dim";

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="mt-6 rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint ? <p className="mt-0.5 text-xs text-dim">{hint}</p> : null}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className={field}>
      {label}
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

function Outcome({ error, notice }: { error: string | null; notice: string | null }) {
  if (error)
    return (
      <p role="alert" className="text-xs text-st-failure">
        {error}
      </p>
    );
  return notice ? <p className="text-xs text-st-success">{notice}</p> : null;
}

/** Runs a write behind the step-up and reports its outcome as text. */
function useLaneWrite() {
  const { api } = getBackend();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (
    action: LaneAction,
    input: Record<string, unknown>,
    done: (out: Record<string, unknown>) => string,
  ): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await runLaneWrite(api, signWithPasskey, action, input);
      setNotice(done(out));
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change was refused.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, run };
}

const CONFIRM = "Confirm with passkey and apply";

function Target({
  org,
  project,
  setOrg,
  setProject,
}: {
  org: string;
  project?: string;
  setOrg: (v: string) => void;
  setProject?: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Text label="Target org (slug)" value={org} onChange={setOrg} />
      {setProject ? (
        <Text label="Target project (slug)" value={project ?? ""} onChange={setProject} />
      ) : null}
    </div>
  );
}

function PinRepo() {
  const w = useLaneWrite();
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [repo, setRepo] = useState("");
  return (
    <Section
      title="Pinned repository"
      hint="The one repository a project releases from (owner/name)."
    >
      <Target org={org} project={project} setOrg={setOrg} setProject={setProject} />
      <Text label="Repository" value={repo} onChange={setRepo} placeholder="owner/name" />
      <div>
        <Button
          size="sm"
          disabled={w.busy || !org || !project || !repo}
          onClick={() =>
            void w.run(
              "release_pin_repo",
              { target_org: org.trim(), target_project: project.trim(), repo: repo.trim() },
              (o) => `Pinned ${String(o.repo)} (lane config version ${String(o.config_version)}).`,
            )
          }
        >
          {CONFIRM}
        </Button>
      </div>
      <Outcome error={w.error} notice={w.notice} />
    </Section>
  );
}

export function KeyView({ k }: { k: LaneKey }) {
  return (
    <dl className="grid gap-1 text-xs">
      <dt className="text-dim">Key id</dt>
      <dd className="break-all font-mono">{k.keyid}</dd>
      <dt className="text-dim">Fingerprint</dt>
      <dd className="break-all font-mono">{fingerprintOf(k.keyid)}</dd>
      <dt className="text-dim">Created</dt>
      <dd>{k.createdAt}</dd>
      <dt className="text-dim">Public key</dt>
      <dd>
        <pre className="overflow-x-auto rounded-md bg-subtle p-2 font-mono">{k.publicKeyPem}</pre>
      </dd>
    </dl>
  );
}

function SigningKey() {
  const { api } = getBackend();
  const w = useLaneWrite();
  const [org, setOrg] = useState("");
  const [name, setName] = useState("release");
  const [key, setKey] = useState<LaneKey | null>(null);
  const [showError, setShowError] = useState<string | null>(null);
  return (
    <Section
      title="Signing key"
      hint="Created inside the lane. Only the public half is shown here. Record the fingerprint somewhere the server cannot edit."
    >
      <Target org={org} setOrg={setOrg} />
      <Text label="Key name" value={name} onChange={setName} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={w.busy || !org || !name}
          onClick={() =>
            void w
              .run(
                "release_init_key",
                { target_org: org.trim(), name: name.trim() },
                () => "Key created. Compare the fingerprint below with the one you record.",
              )
              .then((o) =>
                o
                  ? setKey({
                      keyid: String(o.keyid),
                      publicKeyPem: String(o.public_key_pem),
                      createdAt: String(o.created_at),
                    })
                  : undefined,
              )
          }
        >
          {CONFIRM}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!org || !name}
          onClick={() => {
            setShowError(null);
            api.laneKey({ targetOrg: org.trim(), name: name.trim() }).then(setKey, (e: unknown) => {
              setKey(null);
              setShowError(e instanceof Error ? e.message : "Could not read the key.");
            });
          }}
        >
          Show existing key
        </Button>
      </div>
      <Outcome error={w.error ?? showError} notice={w.notice} />
      {key ? <KeyView k={key} /> : null}
    </Section>
  );
}

const KINDS = ["npm", "github-release", "oci-image"] as const;
const KIND_FIELDS: Record<(typeof KINDS)[number], [string, string][]> = {
  npm: [
    ["package", "Package name"],
    ["artifact", "Tarball artifact"],
    ["secret", "Lane secret name"],
    ["tag", "dist-tag (default latest)"],
    ["access", "Access (public or restricted)"],
  ],
  "github-release": [
    ["assets", "Assets (comma separated)"],
    ["provenance_asset", "Provenance asset (or none)"],
  ],
  "oci-image": [
    ["registry", "Registry host"],
    ["repository", "Repository (owner/name)"],
    ["manifest", "Manifest artifact"],
    ["tags", "Tags (comma separated)"],
    ["username", "Registry user"],
    ["secret", "Lane secret name"],
    ["realm_host", "Token host (if not the registry's)"],
  ],
};

function PublishTargets() {
  const { api } = getBackend();
  const w = useLaneWrite();
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [cfg, setCfg] = useState<LaneConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("npm");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [accept, setAccept] = useState(false);
  const load = () => {
    setLoadError(null);
    api
      .laneConfig({ targetOrg: org.trim(), targetProject: project.trim() })
      .then(setCfg, (e: unknown) => {
        setCfg(null);
        setLoadError(e instanceof Error ? e.message : "Could not read the lane's config.");
      });
  };
  return (
    <Section
      title="Publish targets"
      hint="Where a release is published. A target names a lane secret by name, never a value."
    >
      <Target org={org} project={project} setOrg={setOrg} setProject={setProject} />
      <div>
        <Button size="sm" variant="secondary" disabled={!org || !project} onClick={load}>
          Load targets
        </Button>
      </div>
      <Outcome error={loadError} notice={null} />
      {cfg ? (
        <ul className="text-xs">
          <li>
            Pinned repository: <span className="font-mono">{cfg.pinnedRepo ?? "none"}</span> (config
            version {cfg.configVersion})
          </li>
          {cfg.targets.map((t) => (
            <li key={t.key} className="mt-1 flex items-center gap-2">
              <span className="font-mono">{t.key}</span> {t.kind} ({t.mode}),{" "}
              {t.hasCredential ? "credential set" : "no credential"}
              <Button
                size="xs"
                variant="destructive"
                disabled={w.busy}
                onClick={() =>
                  void w
                    .run(
                      "release_publish_target_delete",
                      { target_org: org.trim(), target_project: project.trim(), key: t.key },
                      () => `Removed ${t.key}.`,
                    )
                    .then(() => load())
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Text label="Target key" value={key} onChange={setKey} placeholder="npm" />
        <label className={field}>
          Kind
          <select
            className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-foreground"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {KIND_FIELDS[kind].map(([k, label]) => (
          <Text
            key={k}
            label={label}
            value={fields[k] ?? ""}
            onChange={(v) => setFields((f) => ({ ...f, [k]: v }))}
          />
        ))}
      </div>
      {kind === "npm" ? (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />I
          accept that publishing uses a long-lived registry token
        </label>
      ) : null}
      <div>
        <Button
          size="sm"
          disabled={w.busy || !org || !project || !key}
          onClick={() =>
            void w
              .run(
                "release_publish_target_set",
                targetInput({
                  targetOrg: org,
                  targetProject: project,
                  key,
                  kind,
                  fields,
                  acceptLongLived: accept,
                }),
                (o) => `Saved ${String(o.key)} (lane config version ${String(o.config_version)}).`,
              )
              .then((o) => (o ? load() : undefined))
          }
        >
          {CONFIRM}
        </Button>
      </div>
      <Outcome error={w.error} notice={w.notice} />
    </Section>
  );
}

function ProjectSigning() {
  const w = useLaneWrite();
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [signingKey, setSigningKey] = useState("builtin:release");
  const [environment, setEnvironment] = useState("");
  const [refs, setRefs] = useState("");
  return (
    <Section
      title="Project signing policy"
      hint="A tenant's release policy: you must also be an owner of the project's org."
    >
      <Target org={org} project={project} setOrg={setOrg} setProject={setProject} />
      <Text
        label="Signing key"
        value={signingKey}
        onChange={setSigningKey}
        placeholder="builtin:release"
      />
      <Text
        label="Approval environment (default release)"
        value={environment}
        onChange={setEnvironment}
      />
      <Text
        label="Release refs (comma separated, default refs/tags/v*)"
        value={refs}
        onChange={setRefs}
      />
      <div>
        <Button
          size="sm"
          disabled={w.busy || !org || !project || !signingKey}
          onClick={() =>
            void w.run(
              "release_set_project_signing",
              signingInput({
                targetOrg: org,
                targetProject: project,
                signingKey,
                environment,
                refs,
              }),
              (o) =>
                `Saved ${String(o.signing_key)} (lane config version ${String(o.config_version)}).`,
            )
          }
        >
          {CONFIRM}
        </Button>
      </div>
      <Outcome error={w.error} notice={w.notice} />
    </Section>
  );
}

/** The write-only secret form: the value is never echoed, and the status shows no value. */
export function SecretFormView(p: {
  org: string;
  project: string;
  name: string;
  value: string;
  status: LaneSecretStatus | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onOrg: (v: string) => void;
  onProject: (v: string) => void;
  onName: (v: string) => void;
  onValue: (v: string) => void;
  onStatus: () => void;
  onSubmit: () => void;
}) {
  return (
    <Section
      title="Publish credential"
      hint="Write-only: the value is sealed in the lane and is never shown or returned again."
    >
      <Target org={p.org} project={p.project} setOrg={p.onOrg} setProject={p.onProject} />
      <Text label="Secret name" value={p.name} onChange={p.onName} placeholder="NPM_TOKEN" />
      <label className={field}>
        Value
        <Input
          type="password"
          name="lane-secret-value"
          autoComplete="new-password"
          spellCheck={false}
          value={p.value}
          onChange={(e) => p.onValue(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={p.busy || !p.org || !p.project || !p.name || !p.value}
          onClick={p.onSubmit}
        >
          {CONFIRM}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!p.org || !p.project || !p.name}
          onClick={p.onStatus}
        >
          Check status
        </Button>
      </div>
      {p.status ? (
        <p className="text-xs" data-testid="secret-status">
          {p.status.set
            ? `Set at ${p.status.setAt ?? "an unknown time"} by ${p.status.setBy ?? "unknown"}.`
            : "Not set."}
        </p>
      ) : null}
      <Outcome error={p.error} notice={p.notice} />
    </Section>
  );
}

function Secret() {
  const { api } = getBackend();
  const w = useLaneWrite();
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [name, setName] = useState("NPM_TOKEN");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<LaneSecretStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const refresh = () => {
    setStatusError(null);
    api
      .laneSecretStatus({ targetOrg: org.trim(), targetProject: project.trim(), name: name.trim() })
      .then(setStatus, (e: unknown) => {
        setStatus(null);
        setStatusError(e instanceof Error ? e.message : "Could not read the status.");
      });
  };
  return (
    <SecretFormView
      org={org}
      project={project}
      name={name}
      value={value}
      status={status}
      busy={w.busy}
      error={w.error ?? statusError}
      notice={w.notice}
      onOrg={setOrg}
      onProject={setProject}
      onName={setName}
      onValue={setValue}
      onStatus={refresh}
      onSubmit={() => {
        const sent = value;
        // Cleared at once: the value lives in this component only until the call is made.
        setValue("");
        void w
          .run(
            "release_secret_set",
            {
              target_org: org.trim(),
              target_project: project.trim(),
              name: name.trim(),
              value: sent,
            },
            (o) => `Stored ${String(o.name)} (lane config version ${String(o.config_version)}).`,
          )
          .then((o) => (o ? refresh() : undefined));
      }}
    />
  );
}

export function ReleaseLanePage() {
  const who = useWhoami();
  if (!who.data) return <Skeleton className="mx-auto mt-8 h-40 w-full max-w-3xl" />;
  if (!canConfigureLane(who.data))
    return (
      <EmptyState title="Not available">
        The release lane is configured by owners of the operator org.
      </EmptyState>
    );
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Release lane</h1>
      <p className="mt-0.5 text-sm text-dim">
        Each change asks you to confirm with your passkey, for exactly that change. A confirmation
        works once and lasts five minutes.
      </p>
      <PinRepo />
      <SigningKey />
      <PublishTargets />
      <ProjectSigning />
      <Secret />
    </div>
  );
}
