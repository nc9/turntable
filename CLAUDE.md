# Turntable

Turntable is an open source CI system. It runs GitHub Actions workflows outside GitHub, on the sandbox or container provider you choose. It ships as a single Bun binary with a built-in web UI. Providers and secret stores are plugins, and security is the core design goal. It is pre-alpha and under active development.

@AGENTS.md

## Working in this repo

- The repo is public. Every commit, issue, PR and comment is visible to everyone. Never commit secrets, internal hostnames, customer data or details of any other company's private systems.
- `CLAUDE.local.md` (gitignored) holds private working notes for this checkout. Read it at the start of every session when it exists.
- Keep `main` green. Work on a branch and open a PR for anything beyond a trivial fix.
- Run heavy work (act runs, sandbox tests, image builds) in a remote sandbox or in CI, not on the development machine.
- Never create tags, publish releases or push images without the maintainer's explicit OK.
