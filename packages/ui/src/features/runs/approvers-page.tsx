import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getBackend } from "@/api";
import type { Approver } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useScope } from "@/features/shell/scope";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { createPasskey, signWithPasskey, webauthnAvailable } from "@/lib/webauthn";
import { LOGIN_PATH, useSession } from "@/lib/session";
import { sanitize } from "@/log/parser";
import { ApiError } from "@/api/http-adapter";

/** Approver keys, the approval policy, and enrolling a new passkey (which needs a quorum). */
export function ApproversPage() {
  const scope = useScope();
  const { api } = getBackend();
  const q = useAsync(() => api.approversOverview(), [scope.orgSlug]);
  const [person, setPerson] = useState("");
  const [forge, setForge] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [signer, setSigner] = useState<Record<string, string>>({});
  const [kpMode, setKpMode] = useState<"any" | "hardware" | null>(null);
  const [kpYubikey, setKpYubikey] = useState<boolean | null>(null);
  const [kpAaguids, setKpAaguids] = useState<string | null>(null);
  const [kpSigner, setKpSigner] = useState("");
  const session = useSession();
  const isOwner =
    session.status === "signed-in" &&
    session.orgs.some((o) => o.slug === scope.orgSlug && o.role === "owner");
  const [needSignIn, setNeedSignIn] = useState(false);
  const simulated = api.capabilities.simulatedCeremony;
  const canCeremony = simulated || webauthnAvailable();

  if (q.error && !q.data)
    return <ErrorState title="Could not load approvers" message={q.error} onRetry={q.reload} />;
  if (!q.data)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-5" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  const d = q.data;
  const passkeyPeople = d.approvers.filter((a: Approver) => a.kind === "webauthn");

  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
      q.reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "That was not accepted." });
    } finally {
      setBusy(false);
    }
  };

  const saveKeyPolicy = () =>
    run(async () => {
      const cur = d.keyPolicy;
      const mode = kpMode ?? cur.mode;
      const yubikey = kpYubikey ?? cur.presets.includes("yubikey");
      const aaguids = (kpAaguids ?? cur.aaguids.join(", ")).split(/[\s,]+/).filter((x) => x !== "");
      const who = passkeyPeople.find((a) => a.id === kpSigner);
      if (!who || who.passkeyId === null)
        throw new Error("Choose who is signing: a policy change needs a signature.");
      const ch = await api.keyPolicyChallenge({
        mode,
        presets: yubikey ? ["yubikey"] : [],
        aaguids,
        approver: who.id,
      });
      const signature = simulated
        ? ({
            kind: "webauthn",
            credential_id: "fixture",
            client_data_json: "fixture",
            authenticator_data: "fixture",
            signature: "fixture",
          } as const)
        : await signWithPasskey({
            challenge: ch.challenge,
            rpId: ch.rpId ?? "",
            passkeyId: ch.passkeyId ?? who.passkeyId,
          });
      const r = await api.approveKeyPolicy({ statement: ch.statement, signature });
      setKpMode(null);
      setKpYubikey(null);
      setKpAaguids(null);
      return r.applied
        ? `Key policy changed to ${mode}.`
        : `Signed. ${r.approvals} of ${r.required} signatures: the policy changes when enough counted approvers sign the same change.`;
    });

  const register = () =>
    run(async () => {
      if (person.trim() === "") throw new Error("Enter the person's name first.");
      if (forge.trim() === "")
        throw new Error("Enter their forge login: approvals are refused without it.");
      const rc = await api.registerChallenge();
      const created = simulated
        ? { clientDataJson: "fixture", attestationObject: "fixture" }
        : await createPasskey({
            challenge: rc.challenge,
            rpId: rc.rpId,
            person: person.trim(),
            attestation: rc.attestation,
          });
      const r = await api.requestEnrolment({
        person: person.trim(),
        forgeLogin: forge.trim(),
        webauthn: { challenge: rc.challenge, ...created },
      });
      setPerson("");
      setForge("");
      return `Requested. It becomes an approver when ${r.required} existing ${r.required === 1 ? "approver signs" : "approvers sign"} it.`;
    });

  // The org's first approver, self-serve (#587): an owner's session, a GitHub sign-in under ten
  // minutes old. A stale sign-in sends the person through GitHub again.
  const enrolFirst = () =>
    run(async () => {
      try {
        const rc = await api.firstApproverChallenge();
        const person = session.login ?? "owner";
        const created = simulated
          ? { clientDataJson: "fixture", attestationObject: "fixture" }
          : await createPasskey({
              challenge: rc.challenge,
              rpId: rc.rpId,
              person,
              attestation: rc.attestation,
            });
        await api.enrolFirstApprover({ webauthn: { challenge: rc.challenge, ...created } });
        return "Your passkey is enrolled as the first approver. New keys now need a quorum of approvers.";
      } catch (e) {
        if (e instanceof ApiError && e.reason === "fresh_sign_in_required") setNeedSignIn(true);
        throw e;
      }
    });

  const approveEnrolment = (enrolmentId: string) =>
    run(async () => {
      const approverId = signer[enrolmentId];
      const who = passkeyPeople.find((a) => a.id === approverId);
      if (!who || who.passkeyId === null) throw new Error("Choose who is signing first.");
      const ch = await api.enrolmentChallenge({ enrolmentId, approver: who.id });
      const signature = simulated
        ? ({
            kind: "webauthn",
            credential_id: "fixture",
            client_data_json: "fixture",
            authenticator_data: "fixture",
            signature: "fixture",
          } as const)
        : await signWithPasskey({
            challenge: ch.challenge,
            rpId: ch.rpId ?? "",
            passkeyId: ch.passkeyId ?? who.passkeyId,
          });
      const r = await api.approveEnrolment({ statement: ch.statement, signature });
      return r.activated
        ? "Approved. The new key is now an approver."
        : `Approved. ${r.approvals} of ${r.required} signatures.`;
    });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <ShieldCheck className="size-5 text-st-approval" aria-hidden="true" />
        Approvers
      </h1>
      <p className="mt-0.5 text-sm text-dim">
        People whose keys can approve a release. A run needs approvals from distinct people, and its
        author cannot approve it.
      </p>

      {d.warnings.length > 0 ? (
        <div
          role="note"
          className="mt-5 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3.5 text-sm"
        >
          {d.warnings.map((w) => (
            <p key={w} className="text-foreground">
              {sanitize(w)}
            </p>
          ))}
        </div>
      ) : null}

      <section aria-labelledby="keys-h" className="mt-6">
        <h2 id="keys-h" className="mb-2 text-sm font-semibold">
          Enrolled keys
        </h2>
        {d.approvers.length === 0 ? (
          <div className="space-y-3 rounded-xl border border-line p-4 text-sm text-dim">
            <p>
              No approver is enrolled.{" "}
              {isOwner
                ? "As an owner of this org you can enrol your own passkey as the first approver. After that, new keys need a quorum of existing approvers."
                : "An owner of this org enrols the first approver with a passkey on this page. After that, new keys need a quorum of existing approvers. On a self-hosted server it can also be enrolled from the server's CLI (turntable approvals bootstrap)."}
            </p>
            {isOwner ? (
              needSignIn ? (
                <p>
                  Enrolling the first approver needs a GitHub sign-in from the last 10 minutes.{" "}
                  <a href={LOGIN_PATH} className="font-medium text-fg underline underline-offset-4">
                    Sign in with GitHub again
                  </a>
                  , then come back to this page.
                </p>
              ) : (
                <Button type="button" disabled={busy || !canCeremony} onClick={enrolFirst}>
                  <KeyRound className="size-4" aria-hidden="true" />
                  Enrol as first approver
                </Button>
              )
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {d.approvers.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
              >
                <span className="min-w-0 flex-1 basis-40 font-medium">{sanitize(a.person)}</span>
                <span className="text-dim">
                  {a.kind === "webauthn" ? "Passkey" : "Offline ed25519 key"}
                </span>
                <span className="text-xs text-dim" title={formatDateTime(a.createdAt)}>
                  {a.forgeLogin ? `${sanitize(a.forgeLogin)}, ` : "no forge login, "}
                  enrolled {formatRelative(a.createdAt)}
                </span>
                {a.notCounting ? (
                  <span className="basis-full text-xs text-st-approval">
                    Not counting: {sanitize(a.notCounting)}.
                  </span>
                ) : a.attested ? (
                  <span className="text-xs text-dim">Hardware attested</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pol-h" className="mt-6">
        <h2 id="pol-h" className="mb-2 text-sm font-semibold">
          Approvals required
        </h2>
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
          {d.policies.map((p) => (
            <li key={p.environment} className="flex flex-wrap items-center gap-x-4 px-4 py-2.5">
              <span className="flex-1 font-mono text-[13px]">{sanitize(p.environment)}</span>
              <span>
                {p.required} {p.required === 1 ? "person" : "people"}
              </span>
              <span className="text-xs text-dim">
                {p.source === "default" ? "default" : "configured"}
                {p.allowAuthorApproval ? ", the author may approve" : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="kp-h" className="mt-6">
        <h2 id="kp-h" className="mb-2 text-sm font-semibold">
          Key policy
        </h2>
        <div className="space-y-3 rounded-xl border border-line p-4 text-sm">
          <p className="text-dim">
            <strong className="font-medium text-fg">any</strong> accepts any passkey with user
            verification, and offline keys.{" "}
            <strong className="font-medium text-fg">hardware</strong> accepts only passkeys whose
            attestation chained to a pinned vendor root, from the allowlist. Touch ID and Face ID
            passkeys give no attestation, so in practice that means security keys.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium" htmlFor="kp-mode">
              Policy
            </label>
            <select
              id="kp-mode"
              value={kpMode ?? d.keyPolicy.mode}
              onChange={(ev) => setKpMode(ev.target.value as "any" | "hardware")}
              className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px]"
            >
              <option value="any">any</option>
              <option value="hardware">hardware</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kpYubikey ?? d.keyPolicy.presets.includes("yubikey")}
                onChange={(ev) => setKpYubikey(ev.target.checked)}
              />
              YubiKey 5 and Bio
            </label>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="kp-aaguids">
              Extra AAGUIDs
            </label>
            <input
              id="kp-aaguids"
              value={kpAaguids ?? d.keyPolicy.aaguids.join(", ")}
              onChange={(ev) => setKpAaguids(ev.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="mt-1 h-9 w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-xs"
              placeholder="comma separated UUIDs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="sr-only" htmlFor="kp-signer">
              Sign as
            </label>
            <select
              id="kp-signer"
              value={kpSigner}
              onChange={(ev) => setKpSigner(ev.target.value)}
              className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px]"
            >
              <option value="">Sign as</option>
              {passkeyPeople.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.person}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !kpSigner || !canCeremony}
              onClick={() => void saveKeyPolicy()}
            >
              <KeyRound />
              Sign the change
            </Button>
          </div>
          <p className="text-xs text-dim">
            A policy change needs the same quorum of counted approvers as enrolling a key.
          </p>
        </div>
      </section>

      {d.pendingEnrolments.length > 0 ? (
        <section aria-labelledby="pend-h" className="mt-6">
          <h2 id="pend-h" className="mb-2 text-sm font-semibold">
            Waiting for approval
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line text-sm">
            {d.pendingEnrolments.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block font-medium">{sanitize(e.person)}</span>
                  <span className="block text-xs text-dim">
                    forge login {e.forgeLogin ? sanitize(e.forgeLogin) : "not set"}
                  </span>
                  <span className="block font-mono text-xs text-dim">
                    key {e.keyFingerprint.slice(0, 16)}, {e.approvals} of {e.required} signatures
                  </span>
                </span>
                <label className="sr-only" htmlFor={`signer-${e.id}`}>
                  Sign as
                </label>
                <select
                  id={`signer-${e.id}`}
                  value={signer[e.id] ?? ""}
                  onChange={(ev) => setSigner({ ...signer, [e.id]: ev.target.value })}
                  className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px]"
                >
                  <option value="">Sign as</option>
                  {passkeyPeople
                    .filter(
                      (a) =>
                        (a.forgeLogin ?? a.person).toLowerCase() !==
                        (e.forgeLogin ?? e.person).toLowerCase(),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.person}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !signer[e.id] || !canCeremony}
                  onClick={() => void approveEnrolment(e.id)}
                >
                  <KeyRound />
                  Approve with passkey
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="reg-h" className="mt-6">
        <h2 id="reg-h" className="mb-2 text-sm font-semibold">
          Register a passkey
        </h2>
        {d.approvers.length === 0 ? (
          <p className="text-sm text-dim">Enrol the first approver from the server CLI first.</p>
        ) : (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              void register();
            }}
            className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-2"
          >
            <div>
              <label htmlFor="ap-person" className="text-sm font-medium">
                Person
              </label>
              <Input
                id="ap-person"
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                className="mt-1.5"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label htmlFor="ap-forge" className="text-sm font-medium">
                Forge login
              </label>
              <Input
                id="ap-forge"
                required
                value={forge}
                onChange={(e) => setForge(e.target.value)}
                className="mt-1.5"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="ap-forge-help"
              />
              <p id="ap-forge-help" className="mt-1 text-xs text-dim">
                Required. Lets the rule that authors cannot approve their own runs recognise them.
              </p>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" disabled={busy || !canCeremony}>
                <KeyRound />
                Register passkey
              </Button>
              {!canCeremony ? (
                <p className="mt-2 text-xs text-dim">
                  Passkeys need a current browser and an https address.
                </p>
              ) : null}
            </div>
          </form>
        )}
      </section>

      {msg ? (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`mt-4 text-sm ${msg.ok ? "text-st-success" : "text-st-failure"}`}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
