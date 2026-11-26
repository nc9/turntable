# Turntable

Secure MCP-first CI runner for cloud containers.

Turntable is an open source CI system. It runs GitHub Actions workflows outside GitHub, on the sandbox or container provider you choose. It ships as a single compiled Bun binary with a built-in web UI. Security is a design goal from the start, not an add-on.

It is early and under active development: it runs our own CI, and interfaces can still change.

## Core features

One rule shapes the design: **a job holds untrusted code or usable credentials, never both.** The full list, with links to how each part works, is in [Core features](docs/features.mdx).

**Secrets never meet untrusted code**
- **Trust classes.** Every run is classed at ingest from forge facts, never from pull request text. Fork pull requests get no secrets and no write token, even after approval.
- **Secrets proxy.** A sandbox never holds a raw secret: a proxy adds credentials to outbound requests per allowed host.
- **Scoped secrets vault.** Secrets are bound to org, project, environment, ref pattern, trust classes and destination hosts, and every use is audited.
- **Egress denied by default**, checked from inside the sandbox before a job with credentials starts.
- **Your own OIDC issuer** per org, and a GitHub token per job that is revoked when the job ends.

**Supply-chain defence**
- **Action pins and moved tags.** Every `uses:` is pinned to a commit. A tag that moves fails protected and release runs until an operator accepts the new commit.
- **Impostor commits refused.** An action commit must be reachable from the repository it names, not only from a fork.
- **Workflow source and taint.** Privileged triggers read the workflow from the protected base branch, never from the pull request head.
- **Cache isolation.** A job never restores a cache written by a lower trust class.

**People approve, agents cannot**
- Approvals are bound to the run's commit and workflow hash. By default agents cannot approve (`no_agents`), and a project can require signed approvals from passkeys or hardware keys.
- **Signed releases.** A separate release lane alone holds the signing key and publish credentials. It re-checks the tag and recomputes digests, and approvals name the exact artifact set.
- **Tamper-evident audit log.** A per-org hash chain with signed checkpoints anchored off the instance. An incident freeze stops scheduling in one call.

**Built for agents, runs anywhere**
- **MCP, REST, CLI and web UI** from one operations registry, with events over SSE, signed webhooks and WebSocket.
- **Your compute.** Docker and Daytona are built in, and providers are plugins with a conformance suite.
- **Your workflows.** GitHub Actions YAML runs through [act](https://github.com/nektos/act). See [Compatibility](docs/compatibility.mdx).
- **Adopt beside your current CI.** Shadow checks never block, and `turntable parity` compares results job by job.
- **One binary** with a built-in web UI, on SQLite or Postgres. Settings work in the UI, `turntable.toml` or the environment.

## Dogfooding

Turntable is dogfooded by squirrelscan. It runs the CI workflows of [squirrelscan/squirrelscan](https://github.com/squirrelscan/squirrelscan) alongside their existing CI and checks that the results match.

## Try it

```sh
bun install
bun run dev                       # serve on 127.0.0.1:8080
curl http://127.0.0.1:8080/healthz
```

Build the binaries into `dist/` with `bun run build`. The server binds to `127.0.0.1` unless you pass `--host` or set `TURNTABLE_HOST`. Run one job of a workflow in a local Docker sandbox with `turntable run <workflow> -j <job>`. The [quickstart](docs/quickstart.mdx) covers polling a repository and the rest of the setup.

## Setup skills

Agent skills in [`skills/`](skills) walk an operator, or their coding agent, through self-hosting and the GitHub App. In Claude Code: `/plugin marketplace add turntable-ci/turntable`, then `/plugin install turntable@turntable`. See [Setup skills](docs/skills.mdx).

## Development

See [AGENTS.md](AGENTS.md) for conventions. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
