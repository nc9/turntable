# Follow-ups

- Refuse unsupported signing backends at config time. `policy set --signing-key aws-kms:<key>` and `gcp-kms:<key>` pass `parseKeyRef` (`packages/core/src/signing/service.ts`, `packages/core/src/ops/policy-cli.ts`), and the refusal only happens at signing time as `no_backend`, because the release lane wires the built-in signer only (`packages/core/src/release/serve.ts`). `policy set` should reject a backend with no signer wired. Open a GCP KMS issue as well.

- Web Push with a service worker (closed tabs). Browser notifications for approvals (#545) need an open tab. A service worker with Web Push would reach a person whose tab is closed; it needs a VAPID key pair, a stored push subscription per browser, and the same fixed templates over `my_pending_approvals`.
- #425 email and Slack sinks on the same item feed. `my_pending_approvals` and the `approval.changed`, `approval.required` and `job.state_changed` events are the feed; the sinks should reuse the same eligibility function and the same fixed, repository-text-free templates.
- Realtime for web sessions. A signed-in session cannot open the realtime socket (it takes bearer tokens only), so the UI polls `my_pending_approvals` (30 s visible, 120 s hidden) and refetches on focus. Letting a session open the socket would make approval notices immediate and work for a hidden tab; that is a change to who may subscribe, so it needs its own issue.
- A person-wide op scope. `my_pending_approvals` is called with one org (the dispatcher resolves a session to one org) and answers for all of the person's orgs. A first-class scope for ops about the person, not an org, would remove that.
- Release requests waiting on a person. `my_pending_approvals` has no `release_request` kind, because a release request never waits on a person today (it is queued for the release lane). Add the kind to the op's enum, the UI types and the docs when a release request can wait on someone, with the same eligibility check as the approving code.

## Release lane configuration (#541)

- For stable (#352): the lane verifies a signed approval statement over each config change itself, instead of trusting the main process's step-up check.
- When `docs/releasing.mdx` lands, update its CLI-only note to point at the hosted setup operations in `docs/release-lane.mdx` ("Hosted setup (no shell)").
- The config version is recorded when the lane approves a release (when it signs), not when the human's approval statement was given in the main database. Carrying the version into the approval request itself would also cover a change between the human approval and the lane's signing.
- The config channel needs the release proxy and channel to be on (`TURNTABLE_RELEASE_PROXY_PORT` and `TURNTABLE_RELEASE_CHANNEL_KEY_FILE`); a lane that publishes only in strict mode with no proxy cannot be configured this way yet.
- A refused lane call (lane down, bad key) happens after the step-up is spent. A preflight that checks the lane is reachable before the dispatcher spends it would save the approver a second tap.

## Read-acknowledged output cap (#690)

- Replace the sandbox's drop-the-middle output cap with a read-acknowledged one. Today a sandbox keeps the first 1 MiB and the last 64 MiB of a step's raw output (`OUTPUT_TAIL_BYTES` in `packages/provider-sdk/src/cap-output.ts`) and drops the middle when the controller has not read it in time. The root fix is a provider contract where the sandbox only discards output the controller has acknowledged reading, plus provider-conformance cases for it. Acceptance: the contract is in `docs/providers.mdx`; a conformance test shows an unread range is never dropped (the exec blocks or is bounded by disk, not by a cut); a slow reader produces no `job_cuts` entry; the 64 MiB tail cap then only applies to acknowledged output. Priority P1.
- Run the supervised release lane as a separate uid with a non-dumpable launcher. The supervised child (#678) separates the lane from the server by process, not by uid. The server keeps the release values in a closure and in its boot-time `/proc/self/environ`, and the child runs as the same user, so code execution in the server can read them.
  Acceptance:
  - A small launcher starts first (as root, before the server drops privileges), holds the release values, marks itself non-dumpable (`PR_SET_DUMPABLE=0`), and starts the lane child as a different uid.
  - The server process never receives any `TURNTABLE_RELEASE_*` value, in `process.env`, in `/proc/self/environ` or in memory.
  - The lane's data directory and key files belong to the child's uid and are unreadable by the server's uid; a test shows the server uid cannot read them or `/proc/<child pid>/environ`.
  - Restart and backoff behaviour, the 0700 socket and the per-boot channel keys work as in the same-uid option.
  - `docs/release-lane.mdx` and `docs/hosted.mdx` drop the same-uid residual risk.
