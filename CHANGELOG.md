# Changelog

All notable changes to Longshore are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the scheme in [docs/releases.mdx](docs/releases.mdx). Until 1.0, prereleases are `v0.x.y-alpha.N` and may break between alphas.

Items marked `[pending #N]` describe a change that is still in review. Remove the marker when it merges, or move the item out if it misses the tag.

## [0.1.0-alpha.1] - Unreleased

The first prerelease. Longshore runs GitHub Actions workflows outside GitHub, one job per sandbox, on a sandbox provider you choose. It ships as a single binary and a distroless image with a built-in web UI, and it is built around one rule: a job holds untrusted code or usable credentials, never both.

### Added

**Running workflows**

- One binary: `longshore serve` (web UI, REST API, MCP, worker, poller, or any subset with `--roles`), `longshore run` for one job of a workflow, `longshore version`. SQLite by default, with migrations embedded in the binary.
- Workflows run through [act](https://github.com/nektos/act) in a sandbox, per job, with multi-job planning, `needs` and outputs, the expression evaluator, a trigger router, a checkout stub (ref, path, fetch depth, submodules) and live log parsing into steps. Steps see no terminal, as on GitHub's runner.
- A leased scheduler with fair claiming, exec re-attach after a restart, immediate cancel and group queueing.
- Sandbox providers: Docker and Daytona, behind a provider SDK with detached exec and offset-based logs, and a conformance suite. A runner image with PowerShell and a generated toolset table, and a clear notice when a workflow needs a tool the image lacks.
- Ingest from GitHub: webhooks (signature verified) and read-only polling, pull requests and merge queue runs, per-project ingest settings, a GitHub App with a manifest flow, installation claim for hosted use, and shadow or live check runs.
- A web UI (Geist and shadcn style) with a live log viewer, trust badges, approvals, failure digests, server-side log grep and ingest status. Realtime over WebSocket with cursor replay.

**For agents**

- One operations registry behind REST, OpenAPI and MCP (stdio and HTTP). Scoped agent tokens, roles, an event feed with long-poll, `failure_digest`, `job_log` grep, and untrusted-content envelopes on anything that carries forge or log text.
- A Claude Code channel over the event feed, with cursor resume.

**Secrets and credentials**

- A vault of scoped, versioned secrets with per-use audit, rotation with overlap, and environment scrubbing. Secrets are set only over https or the CLI, never over MCP.
- A secrets proxy: a job reaches only the proxy, which attaches a secret to requests for the hosts a rule names, and scrubs it from responses. A scoped, short-lived GitHub token per job, delivered through the proxy.
- A per-org OIDC issuer with rotating keys.
- Incident freeze and unfreeze, rotation flags and a secret usage query.

**Releases**

- A release lane, a separate process that holds the signing keys, re-checks the tag at the forge, recomputes artifact digests itself and signs SLSA provenance. Built-in and KMS key backends, and `longshore verify`.
- Strict publishing to npm and GitHub Releases from the bytes the lane verified. Compat publishing for existing workflows: the job runs its own publish command through a lane-hosted proxy that holds the credential, pinned to the approved package, tarball and draft release. The lane checks the result afterwards, including a pushed container image and its provenance as an OCI referrer.
- Release binaries for linux x64 and arm64 and darwin arm64 (ad-hoc signed, not notarized), a distroless image, SBOMs, artifact attestations, an OpenSSF Scorecard run, and release notes drafted from commits.

### Security

- **Trust classes** from forge facts (`protected`, `release`, `trusted_pr`, `untrusted_pr`), with privileged-trigger demotion, held runs for untrusted authors, and a sha-bound, workflow-hash-bound approval that never raises a class.
- **Egress is deny-by-default.** A sandbox has no route out unless policy allows it, with an enforcement check and a canary probe before the job starts. A job that holds secrets runs only behind the proxy: on Docker, deny-all-except-proxy on an isolated network; on Daytona, an allow list of the proxy's addresses.
- **Isolation levels** with class minimums: a job never starts on a provider weaker than its class allows, and an override is audited.
- **Action pinning**: remote actions are resolved to commit shas, fail closed when unpinned, and a moved tag stops protected and release runs until a person accepts it.
- **A hash-chained audit log** with signed checkpoints, anchored verification, export, and refusal of a truncated chain.
- **Human-only approvals** with WebAuthn or offline signatures and a two-person rule for production and release.
- **An SSRF-guarded outbound client** (DNS pinning, redirect re-validation, byte caps) used for every control-plane request, enforced by a source guard test.
- **Drops root** after taking ownership of the data directory, and redirects plain http to https behind a trusted proxy with HSTS.
- **A secrets redactor** that streams, with an exact-value registry.
- **Supply chain**: every action pinned by commit sha, images by digest and downloads by checksum, a 14-day minimum age for new dependency versions, and SBOMs and attestations on release assets.

### Upgrade notes

This is the first release, so there is nothing to upgrade from. These notes are for anyone running a build from `main` before the tag.

- **Release signing keys are per org.** Built-in keys are stored under the org's id. A key made earlier under a bare name is no longer found and nothing falls back to it. Create it again with `longshore release init-key --org <slug> --name <key>`, pin the new public key and point the project at it. Releases signed with the old key still verify against the old public key. A KMS key may belong to one org only, and signing is refused if two orgs name the same one.
- **Secret records move to a key per org.** [pending #175] New records are written in a `v3` format keyed per org. Older records still open. `longshore keys reseal --org <slug>` converts an org in place, and `LONGSHORE_REQUIRE_ORG_KEYS=1` then refuses anything older. This is forward-only: an older Longshore cannot read a `v3` record, so take a backup first and see Rollback.
- **Artifacts record the trust class of the run that made them.** [pending #178] Artifacts recorded before this change are treated as `untrusted_pr` and cannot be signed: re-record them from a release run. Signing refuses an artifact that is not release class.
- **Per-org quotas.** [pending #182] There are none by default: an org with no quota row is unlimited, as before, and the instance's per-org concurrency cap still applies. Set limits with the `set_quotas` operation (REST only, not MCP). A reached limit holds new claims and running attempts finish.
- **Dropping privileges.** The image starts as root, takes ownership of `/data` and the files it expects there, and drops to user 65532 before opening the database or any key. Platforms that mount a root-owned volume (such as Railway) need nothing else: do not set `RAILWAY_RUN_UID=0`. Outside the image, `LONGSHORE_DROP_PRIVILEGES=<uid>:<gid>` turns it on.
- **Egress for jobs that hold secrets.** A project with proxy rules runs those jobs behind the secrets proxy with no other route. Hosts a job must tunnel to without injection (checkout, a package registry) are listed per project with the passthrough host operations. A secret-bearing job on a provider that cannot enforce this is refused, not run open.
- **Some setters are not MCP tools**: proxy rules and passthrough hosts, accepting a moved action tag, unfreezing an incident and the approval challenge operations are REST and CLI only. The operations table in [the agent interface docs](docs/agent-interface.mdx) lists what each surface offers.

### Known limits

- **SQLite only.** Postgres is planned. The schema uses portable types so the port is mechanical, but there is no Postgres dialect yet, so the docs that mention a Postgres snapshot describe the future.
- **No external provider plugins.** The gate (name, path and sha256, off in hosted mode) is in place, but there is no loader, so the JSON-RPC stdio plugin transport is not built. Only the Docker and Daytona providers run.
- **The Daytona proxy path is not verified against a live account.** It is built from a spike's measured behaviour (allow lists, the TLS listener, the in-sandbox relay) and tested against a mock. Treat Daytona with secret-bearing jobs as untested until it has run for real.
- **Container image publishing is compat only.** The lane verifies a pushed image and attaches provenance as an OCI referrer where the registry supports it, and says so when it cannot. Token endpoints must be on the registry's host or one host the target names.
- **npm publishing uses a long-lived token.** npm's trusted publishing does not accept a self-hosted issuer. The token is opt-in, held only by the release lane, and a publish whose `package.json` the npm client would rewrite must use strict mode.
- **The darwin binary is ad-hoc signed, not notarized.** Verify it with the checksum and attestation, then clear the quarantine flag (see [docs/releases.mdx](docs/releases.mdx)).
- **No UI or CLI for quotas or artifact provenance yet.** Operations and REST only.
- **Mac and Windows runners, other forges and a hosted offering** are out of scope for this release.

### Rollback

Migrations only go forward, so a rollback is a restore:

1. Stop the new version.
2. Restore the data directory from the backup taken before the upgrade (the SQLite database with its `-wal` and `-shm` files, the master key file and its `.audit-state` directory, and the release lane's own data directory if you run one).
3. Start the previous version by its image digest (`ghcr.io/nc9/longshore@sha256:<digest>`) or its binary, whose checksum you recorded.

Do not start an older version against a data directory that a newer one has migrated or resealed: it cannot read `v3` secret records and does not know the newer tables. Never move or delete a published tag; publish a fixed version under a new tag and say which digest to run. See [docs/releases.mdx](docs/releases.mdx) for verifying a download and for rolling back a bad release.
