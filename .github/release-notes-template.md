## Turntable {{version}}

<!-- Highlights: two or three sentences a person would care about. Edit before publishing. -->

## Breaking changes

{{breaking}}

## Database migrations

{{migrations}}

## Changes

{{changes}}

{{skipped}}

## Upgrade and rollback

Upgrade: stop the old binary or container, back up the data directory (SQLite) or take a database snapshot (Postgres), then start the new version. Migrations run on start.

Rollback: stop, restore the backup, and start the previous version. Migrations are forward-only, so a rollback after a migration needs the restore.

## Verify your download

```sh
sha256sum -c SHA256SUMS
gh attestation verify turntable-linux-x64 --repo turntable-ci/turntable
```

The darwin binary is ad-hoc signed, not notarized. See the [release docs](https://github.com/turntable-ci/turntable/blob/main/docs/releases.mdx) for the image digest, SBOMs and Gatekeeper notes.

{{compare}}
