# Longshore

Longshore is an early, pre-alpha project under active development. Nothing here is ready for real use, and interfaces will change without notice.

## What it will be

Longshore aims to be a CI system that reads GitHub Actions workflow YAML and runs it outside GitHub, on a sandbox or container provider you choose. Providers and secret stores will be plugins.

It ships as a single compiled Bun binary with a built-in web UI. It uses SQLite by default, with Postgres planned, through Drizzle. Security is a design goal from the start, not an add-on.

## What exists today

A skeleton only: a server with `GET /healthz` and a placeholder page, an embedded SQLite migration, and a build pipeline that produces binaries and a container image. There is no workflow execution yet.

## Try it

```sh
bun install
bun run dev                       # serve on 127.0.0.1:8080
curl http://127.0.0.1:8080/healthz
```

Build the binaries into `dist/` with `bun run build`. The server binds to `127.0.0.1` unless you pass `--host` or set `LONGSHORE_HOST`.

## Development

See [AGENTS.md](AGENTS.md) for conventions. Report security issues as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
