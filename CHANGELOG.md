# Changelog

All notable changes to Longshore are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the scheme in [docs/releases.mdx](docs/releases.mdx). Until 1.0, prereleases are `v0.x.y-alpha.N` and may break between alphas.

Items marked `[pending #N]` describe a change that is still in review. Remove the marker when it merges, or move the item out if it misses the tag.

## [0.1.0-alpha.1] - Unreleased

The first prerelease. Longshore runs GitHub Actions workflows outside GitHub, one job per sandbox, on a sandbox provider you choose. It ships as a single binary and a distroless image with a built-in web UI, and it is built around one rule: a job holds untrusted code or usable credentials, never both.

### Added

**Running workflows**

- One binary: `longshore serve` (web UI, REST API, MCP, worker, poller, or any subset with `--roles`), `longshore run` for one job of a workflow, `longshore version`. SQLite by default, with migrations embedded in the binary, or Postgres (see Storage).
- Workflows run through [act](https://github.com/nektos/act) in a sandbox, per job, with multi-job planning, `needs` and outputs, the expression evaluator, a trigger router, a checkout stub (ref, path, fetch depth, submodules) and live log parsing into steps. Steps see no terminal, as on GitHub's runner.
- A leased scheduler with fair claiming, exec re-attach after a restart, immediate cancel and group queueing.
- Sandbox providers: Docker and Daytona, behind a provider SDK with detached exec and offset-based logs, and a conformance suite. A runner image with PowerShell and a generated toolset table, and a clear notice when a workflow needs a tool the image lacks.
- **Daytona on a shared account.** A `fleet` option scopes the label, the name prefix and every count, list and delete to one fleet, so two instances never touch each other's sandboxes. Our own live sandboxes are counted by the ids we recorded, not by listing, adopted at boot, and unconfirmed destroys are swept. Before each create the provider waits on the org's CPU, disk and memory quotas, and treats a quota refusal on create as capacity: it waits and retries. A key that cannot read the org's usage falls back to counting our own fleet (`quotaMode`). The live-sandbox ceiling is 10 (the default stays 2). The label count of the account owner's other CI is optional and off by default, and its labels come from configuration.
- Ingest from GitHub: webhooks (signature verified) and read-only polling, pull requests and merge queue runs (from verified merge queue branches), per-project ingest settings with no poll entry needed, tags ingested as release runs (opt-in per project, only on the default branch's first-parent history), a GitHub App with a manifest flow, installation claim for hosted use, and shadow or live check runs.
- `longshore parity` compares a run with another CI's checks for the same commit, so a shadow run can be judged against the CI it shadows.
- A step timeout watchdog that is safe on Linux, and an exec timeout watcher that leaves no process behind.

**Web UI**

- A web UI (Geist and shadcn style) with a live log viewer, trust badges, approvals, failure digests, server-side log grep and ingest status. Realtime over WebSocket with cursor replay and a log-append notifier, so tails wake at once instead of on a poll.
- An Artifacts tab on each run (provenance, and which classes may consume each artifact, asked of the server), a Quotas page (each limit, its usage and percent, and why new work is held) and approvers with the key policy.
- System notices appear in a job's own log as lines the job cannot forge (for example, cache entries dropped for denied paths).
- The UI can be served from a directory in a run from source, for a quick dev loop. The compiled binary serves only its embedded UI.

**Storage and operations**

- **Postgres.** `--database-url` (or `LONGSHORE_DATABASE_URL`) runs the same server on Postgres, with generated schema and migrations for both dialects, advisory-locked migration at start, and the whole test suite run against it in CI. There is no native dependency: it goes through Bun's built-in SQL client.
- **Hosted instances with no shell.** Configuration from the environment alone, an opt-in first-boot master key (`LONGSHORE_MASTER_KEY_AUTOINIT`), a bootstrap token by hash, an installation claim flow with trusted proxies, and a Railway deploy guide. Documentation for the live GitHub verification runbook.
- **Instance administrator.** A separate token (`lsi_`) for the few settings that belong to no org, accepted over REST only, minted on the host, holding no org grant.
- The runtime image carries git and tar, and the image smoke test runs a real git fetch by sha as the unprivileged user.
- Every data-dir subcommand drops root, and the chown walk uses parent descriptors so it never blocks on a FIFO.

**Quotas and usage**

- **Per-org quotas** on concurrent attempts, runs per hour, sandbox minutes per day, stored log bytes and stored artifact and cache bytes. A reached limit holds new claims only; running attempts finish. They are set by the instance operator, on the host (`longshore quotas set`) or with the instance administrator token over REST, and read with `longshore quotas get`, the `get_quotas` operation and the Quotas page. `quota.warning` and `quota.reached` are events of their own, fired once per window.
- **Exact sandbox time.** Each attempt records when the provider's sandbox was created and when its destroy was confirmed. `sandbox_usage` returns sandbox seconds per UTC day, and it is the figure quotas limit.

**For agents**

- One operations registry behind REST, OpenAPI and MCP (stdio and HTTP). Scoped agent tokens, roles, an event feed with long-poll, `failure_digest`, `job_log` grep, and untrusted-content envelopes on anything that carries forge or log text.
- **Server-sent events and signed outbound webhooks.** Push the event feed to a URL you choose, signed with a per-org secret that rotates with a 24 hour overlap, retried with backoff, public `https` addresses only (checked again at connect time), with a delivery log.
- A Claude Code channel over the event feed, with cursor resume.

**Secrets and credentials**

- A vault of scoped, versioned secrets with per-use audit, rotation with overlap, and environment scrubbing. Secrets are set only over https or the CLI, never over MCP.
- **A key per org.** Sealed records are keyed per org (the `v3` format), so a record moved to another org does not open. `longshore keys reseal --org <slug>` converts an org in place.
- A secrets proxy: a job reaches only the proxy, which attaches a secret to requests for the hosts a rule names, and scrubs it from responses. Docker runs it behind an isolated network and Daytona through a public TLS listener and an in-sandbox relay. A scoped, short-lived GitHub token per job, delivered through the proxy.
- A per-org OIDC issuer with rotating keys. Delivery to jobs (`permissions: id-token: write`, through the proxy, with a per-request credential) is `[pending #223]`.
- Incident freeze and unfreeze, rotation flags and a secret usage query.
- Human approvals with a per-org key policy: any key, or hardware only (attestation chained to a pinned vendor root, with an AAGUID allowlist). Approver identity is the verified forge login.

**Job cache and artifacts**

- A control-plane cache with a namespace per org, project, trust class and ref scope, canonicalised archives and a per-job credential that dies with the job. Blobs are encrypted at rest per org, and an entry at a denied path is dropped (with a notice in the job's log) instead of failing the whole cache.
- Artifacts carry the trust class of the attempt that made them. A release build consumes nothing a lower class could write, and `longshore artifacts list|check` and the Artifacts tab show what may consume what.

**Releases**

- A release lane, a separate process that holds the signing keys, re-checks the tag at the forge, recomputes artifact digests itself and signs SLSA provenance. Built-in and KMS key backends, and `longshore verify`.
- Strict publishing to npm and GitHub Releases from the bytes the lane verified. Compat publishing for existing workflows: the job runs its own publish command through a lane-hosted proxy that holds the credential, pinned to the approved package, tarball and draft release. The lane checks the result afterwards, including a pushed container image and its provenance as an OCI referrer.
- A dry-run mode for the release workflow, tag-push-to-published golden path tests, and approvals that expire and close.
- Release binaries for linux x64 and arm64 and darwin arm64 (ad-hoc signed, not notarized), a distroless image, SBOMs, artifact attestations, an OpenSSF Scorecard run, and release notes drafted from commits.

### Security

- **Trust classes** from forge facts (`protected`, `release`, `trusted_pr`, `untrusted_pr`), with privileged-trigger demotion, held runs for untrusted authors, and a sha-bound, workflow-hash-bound approval that never raises a class.
- **Egress is deny-by-default.** A sandbox has no route out unless policy allows it, with an enforcement check and a canary probe before the job starts. A job that holds secrets runs only behind the proxy: on Docker, deny-all-except-proxy on an isolated network; on Daytona, an allow list of the proxy's addresses.
- **Isolation levels** with class minimums: a job never starts on a provider weaker than its class allows, and an override is audited. The gate for external provider plugins is in place: only by pinned digest, never in hosted mode.
- **Tenant isolation is tested adversarially.** A suite generated from the operations registry attacks org A as org B over REST, MCP and the realtime socket, and a key audit says which keys are per org.
- **Action pinning**: remote actions are resolved to commit shas, fail closed when unpinned, and a moved tag stops protected and release runs until a person accepts it.
- **A hash-chained audit log** with signed checkpoints, anchored verification, export, and refusal of a truncated chain.
- **Human-only approvals** with WebAuthn or offline signatures and a two-person rule for production and release. The two-person rule counts distinct verified logins, and the author of a run cannot approve it.
- **An SSRF-guarded outbound client** (DNS pinning, redirect re-validation, byte caps) used for every control-plane request, enforced by a source guard test. A tunnel never honours the server's private-address allowlist.
- **Drops root** after taking ownership of the data directory, and redirects plain http to https behind a trusted proxy with HSTS.
- **A secrets redactor** that streams, with an exact-value registry.
- **Supply chain**: every action pinned by commit sha, images by digest and downloads by checksum (checked in CI), a 14-day minimum age for new dependency versions, and SBOMs and attestations on release assets.
- **Strict secret handling on upgrade.** `LONGSHORE_REQUIRE_ORG_KEYS=1` refuses a record that is not under its org's key, and `keys reseal` refuses to run while it is set, so a stale copy cannot be put back.

### Fixed

- A step that ends the exec no longer leaves a sleep behind (the timeout watcher is its own process group). `[pending #234, #240]` covers the watcher surviving its group's teardown and working without setsid or a tty.
- The hosted end-to-end tests wait for a run by condition, not a fixed delay, and the provider fault tests no longer read machine-global state.
- A refused release request is answered before the registration is ended by the sweep. Artifact sizes are validated and the stored-bytes sum is clamped.
- Audit: an unreadable or missing anchor state is alerted on every pass, and a truncated chain is refused.
- PR-event parity: a clean repo tarball, an `origin` remote and the event payload for act.

### Upgrade notes

This is the first release, so there is nothing to upgrade from. These notes are for anyone running a build from `main` before the tag.

- **Release signing keys are per org.** Built-in keys are stored under the org's id. A key made earlier under a bare name is no longer found and nothing falls back to it. Create it again with `longshore release init-key --org <slug> --name <key>`, pin the new public key and point the project at it. Releases signed with the old key still verify against the old public key. A KMS key may belong to one org only, and signing is refused if two orgs name the same one.
- **Secret records move to a key per org.** New records are written in a `v3` format keyed per org. Older records still open. `longshore keys reseal --org <slug>` converts an org in place, and `LONGSHORE_REQUIRE_ORG_KEYS=1` then refuses anything older. This is forward-only: an older Longshore cannot read a `v3` record, so take a backup first and see Rollback.
- **Artifacts record the trust class of the run that made them.** Artifacts recorded before this change are treated as `untrusted_pr` and cannot be signed: re-record them from a release run. Signing refuses an artifact that is not release class.
- **Per-org quotas.** There are none by default: an org with no quota row is unlimited, as before, and the instance's per-org concurrency cap still applies. Set limits on the host with `longshore quotas set` or with the instance administrator token. Quotas are never set over an org token or MCP, and a stored concurrency limit can only lower the instance's cap. Quota notices are now `quota.warning` and `quota.reached` events: the migration converts earlier `infra.error` notices (on both databases), so a consumer that matched `error_class` should match the new types.
- **Sandbox minutes use create-to-destroy time.** The quota counts from the provider's create to its confirmed destroy. An attempt with no confirmed destroy counts to its finish plus 30 minutes (never past now), and one with no recorded create time counts from its start. Those figures are marked `estimated` and can only over-count. The daily cap is checked when a claim is made, so it can overshoot by up to the concurrency times a sandbox's lifetime. `[pending #218]`
- **Dropping privileges.** The image starts as root, takes ownership of `/data` and the files it expects there, and drops to user 65532 before opening the database or any key. Platforms that mount a root-owned volume (such as Railway) need nothing else: do not set `RAILWAY_RUN_UID=0`. Outside the image, `LONGSHORE_DROP_PRIVILEGES=<uid>:<gid>` turns it on.
- **Egress for jobs that hold secrets.** A project with proxy rules runs those jobs behind the secrets proxy with no other route. Hosts a job must tunnel to without injection (checkout, a package registry) are listed per project with the passthrough host operations. A secret-bearing job on a provider that cannot enforce this is refused, not run open.
- **Daytona label settings moved to configuration.** The account owner's label names are no longer built in: set `ownerCiLabels` if you want the label count (it is off by default), and give a `fleet` to isolate an instance on a shared account.
- **Some setters are not MCP tools**: proxy rules and passthrough hosts, accepting a moved action tag, unfreezing an incident, quotas, the instance operations and the approval challenge operations are REST and CLI only. The operations table in [the agent interface docs](docs/agent-interface.mdx) lists what each surface offers.
- **Postgres is opt-in.** Nothing changes for an existing SQLite instance. There is no tool to move data from SQLite to Postgres; start a Postgres instance fresh.

### Known limits

- **Hosted multi-tenant mode needs a microVM-class provider, and none exists yet ([#246](https://github.com/nc9/turntable/issues/246)).** `LONGSHORE_HOSTED=1` requires `microvm` or stronger isolation for every run. Docker and Daytona sandboxes are containers, so a hosted instance refuses every job unless an isolation override reason is given (audited, and shown in each affected job's log). Run a single-org instance with hosted mode off until a microVM provider lands. Postgres row-level security is designed but not built.
- **The control plane still depends on git for run checkouts ([#247](https://github.com/nc9/turntable/issues/247)).** The runtime image carries git and tar for it. Fetching and packing a commit in a child process of the binary (no git or tar, under a deadline and memory ceiling) is `[pending #249]`.
- **PowerShell on Daytona depends on your snapshot.** The Docker runner image carries PowerShell. A Daytona sandbox starts from a snapshot you provide (Longshore never creates snapshots), so a workflow that uses `pwsh` there works only if that snapshot has it. Building the tool into a snapshot for you is not done.
- **No external provider plugins.** The gate (name, path and sha256, off in hosted mode) is in place, but there is no loader, so the JSON-RPC stdio plugin transport is not built. Only the Docker and Daytona providers run.
- **Live verification is still to do.** The Daytona proxy path, the GitHub App manifest flow, the claim flow's OAuth exchange and secret rotation have run against mocks and fake GitHubs only. Run the live verification runbook in [docs/hosted.mdx](docs/hosted.mdx) before trusting them, and treat secret-bearing Daytona jobs as untested until they have run for real. Creating the App from a hosted instance with no shell is `[pending #239]`.
- **Not built yet, in review:** a readiness check (`longshore doctor`, `[pending #192]`), a Usage page and sandbox times on job rows (`[pending #217]`), sandbox size per job (`[pending #232]`) and ID token delivery to jobs (`[pending #223]`).
- **Container image publishing is compat only.** The lane verifies a pushed image and attaches provenance as an OCI referrer where the registry supports it, and says so when it cannot. Token endpoints must be on the registry's host or one host the target names.
- **npm publishing uses a long-lived token.** npm's trusted publishing does not accept a self-hosted issuer. The token is opt-in, held only by the release lane, and a publish whose `package.json` the npm client would rewrite must use strict mode.
- **Checksums use plain SHA-1 for git objects.** The control plane's object checks do not use the collision-detecting variant git uses. The requested sha comes from the forge and GitHub applies the detection when it receives objects.
- **The darwin binary is ad-hoc signed, not notarized.** Verify it with the checksum and attestation, then clear the quarantine flag (see [docs/releases.mdx](docs/releases.mdx)).
- **Mac and Windows runners, other forges and a hosted offering** are out of scope for this release.

### Rollback

Migrations only go forward, so a rollback is a restore:

1. Stop the new version.
2. Restore the data directory from the backup taken before the upgrade (the SQLite database with its `-wal` and `-shm` files, or a Postgres dump, the master key file and its `.audit-state` directory, and the release lane's own data directory if you run one).
3. Start the previous version by its image digest (`ghcr.io/nc9/longshore@sha256:<digest>`) or its binary, whose checksum you recorded.

Do not start an older version against a data directory that a newer one has migrated or resealed: it cannot read `v3` secret records and does not know the newer tables. Never move or delete a published tag; publish a fixed version under a new tag and say which digest to run. See [docs/releases.mdx](docs/releases.mdx) for verifying a download and for rolling back a bad release.
