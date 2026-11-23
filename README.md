# Turntable

Secure MCP-first CI runner for cloud containers.

Turntable is an open source CI system. It runs GitHub Actions workflows outside GitHub, on the sandbox or container provider you choose. It ships as a single compiled Bun binary with a built-in web UI. Security is a design goal from the start, not an add-on.

It is pre-alpha and under active development. Interfaces will change without notice, and it is not ready for general use.

## What exists today

- **Workflow execution.** [act](https://github.com/nektos/act)-compatible: one job per sandbox, with `needs`, outputs, matrices, `if:`, path filters and concurrency. What is and is not supported is listed in [Compatibility](docs/compatibility.mdx).
- **Providers.** Docker and Daytona sandboxes are built in. Providers are plugins with a small, tested contract.
- **Web UI and API.** A built-in dashboard with live logs, and the same operations over REST (OpenAPI) and MCP.
- **Storage.** SQLite by default, Postgres to scale, through Drizzle. Migrations are embedded in the binary.
- **Security.**
  - A secrets vault, and a secrets proxy so a sandbox never holds a raw secret.
  - Per-job tokens, an OIDC issuer, and trust classes for pull requests, with egress denied by default.
  - Human approvals, an incident freeze, and per-org quotas and tenant isolation.
- **Releases.** A separate release lane that re-checks a tag, builds with nothing a lower class could write, signs and publishes.
- **Parity checks.** `longshore parity` compares a run with another CI's check runs for the same commit.

## Dogfooding

Turntable is dogfooded by squirrelscan. It runs the CI workflows of [squirrelscan/squirrelscan](https://github.com/squirrelscan/squirrelscan) alongside their existing CI and checks that the results match.

## Try it

```sh
bun install
bun run dev                       # serve on 127.0.0.1:8080
curl http://127.0.0.1:8080/healthz
```

Build the binaries into `dist/` with `bun run build`. The server binds to `127.0.0.1` unless you pass `--host` or set `LONGSHORE_HOST`. Run one job of a workflow in a local Docker sandbox with `longshore run <workflow> -j <job>`. The [quickstart](docs/quickstart.mdx) covers polling a repository and the rest of the setup.

## Development

See [AGENTS.md](AGENTS.md) for conventions. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
