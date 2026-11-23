# Agent and contributor conventions

- Use bun for everything: `bun install`, `bun run <script>`, `bun test`. Do not use node or npm.
- TypeScript only, strict mode, with explicit types at module boundaries.
- Lint with `oxlint` (`bun run lint`) and format with `oxfmt` (`bun run format`, check with `bun run format:check`).
- Typecheck with `tsgo --noEmit` from `@typescript/native-preview` (`bun run typecheck`).
- File names are kebab-case, for example `run-queue.ts`.
- Commits use conventional commits: `type(scope): message`, with a required scope. Add no attribution or co-author lines.
- Tests live in `packages/<name>/tests/` and run with `bun test <file>`.
- Database schema lives in `packages/core/src/db/schema.ts`. After changing it, run `bun run --cwd packages/core db:generate --name <what_it_does>` (lower snake_case, for example `--name instance_tokens`). It generates both dialects with that name and re-embeds the migrations into the generated modules. Always pass `--name`: drizzle-kit's random names have put customer-like words in public files and the hygiene test fails on them. Commit the SQL, the snapshots, the journals and both generated modules. CI fails if the embedded module is stale.
- The compiled binary must work from an empty directory, so never read runtime assets from disk. Embed them.
- Prose uses sentence-case headings and no em-dashes.
