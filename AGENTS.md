# Agent and contributor conventions

Secure MCP-first CI runner for cloud containers. Turntable is an open source CI system. It runs GitHub Actions workflows outside GitHub, on the sandbox or container provider you choose. It ships as a single Bun binary with a built-in web UI. Providers and secret stores are plugins, and security is the core design goal. It is pre-alpha and under active development.

## Conventions

- Use bun for everything: `bun install`, `bun run <script>`, `bun test`. Do not use node or npm.
- TypeScript only, strict mode, with explicit types at module boundaries.
- Format with `bun fmt` (`bun run format`, check with `bun fmt --check`). There is no lint step; `tsconfig.base.json` turns on `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`.
- Typecheck with `bun check` per package (`bun run typecheck` runs them one at a time).
- File names are kebab-case, for example `run-queue.ts`.
- Commits use conventional commits: `type(scope): message`, with a required scope. Add no attribution or co-author lines.
- Tests live in `packages/<name>/tests/` and run with `bun test <file>`.
- CI runs only listed test files. Add a new test file as one line in a group file, `scripts/test-groups/<group>.txt` (one path per line; pick a group that covers the same area), never on a package.json line. Each `test:<group>` script is `bun scripts/run-test-group.ts <group>`, with any env prefix (`TT_*_E2E=1`) kept in the script. A new group is a new `.txt` file plus a `test:<group>` script. `scripts/test-wiring.test.ts` fails on an unlisted file, and `bun scripts/compare-test-groups.ts <ref>` shows the groups are unchanged against a ref.
- Database schema lives in `packages/core/src/db/schema.ts`. After changing it, run `bun run --cwd packages/core db:generate --name <what_it_does>` (lower snake_case, for example `--name instance_tokens`). It generates both dialects with that name and re-embeds the migrations into the generated modules. Always pass `--name`: drizzle-kit's random names have put customer-like words in public files and the hygiene test fails on them. Commit the SQL, the snapshots, the journals and both generated modules. CI fails if the embedded module is stale.
- The compiled binary must work from an empty directory, so never read runtime assets from disk. Embed them.
- Prose uses sentence-case headings and no em-dashes.

## Working in this repo

- The repo is public. Every commit, issue, PR and comment is visible to everyone. Never commit secrets, internal hostnames, customer data or details of any other company's private systems.
- `CLAUDE.local.md` (gitignored) holds private working notes for this checkout. Read it at the start of every session when it exists.
- Keep `main` green. Work on a branch and open a PR for anything beyond a trivial fix.
- Run heavy work (act runs, sandbox tests, image builds) in a remote sandbox or in CI, not on the development machine.
- Never create tags, publish releases or push images without the maintainer's explicit OK.
