---
name: turntable-self-host
description: Set up a self-hosted Turntable instance from the binary or the Docker image, with the data directory, master key, public URL, trusted proxies and a bootstrap token. Use when the user wants to run Turntable themselves, deploy it on Railway or similar, or fix a first-boot problem.
---

# Self-host Turntable

The docs are the source of truth. This skill is the order of the steps and the places where a wrong move is unsafe. Read the linked page before you act on a step.

## Secret rules (read first)

- Never ask for, read, print or type a token, a master key, an API key or a private key. The human generates and pastes them.
- Never paste a token into a chat or a command line you keep in history. Set only hashes on the server.
- Tokens go in a password manager and in files with mode `0600`. Do not `cat` them.
- Back up the master key on its own, away from volume backups. A volume backup that holds the key is a copy of every secret.

## 1. Run it

Pick one, see [Quickstart](https://github.com/nc9/turntable/blob/main/docs/quickstart.mdx):

- **Binary:** `turntable serve --port 8080 --data-dir ./data`. It works from an empty directory. It listens on `127.0.0.1` unless you pass `--host` or set `TURNTABLE_HOST`.
- **Docker:** `docker run -p 8080:8080 -v turntable-data:/data ghcr.io/nc9/turntable`. The image is distroless, starts as root only to own `/data`, then drops to `65532`. Do not set `TURNTABLE_ALLOW_ROOT`.

Check it with `curl <url>/healthz`. Run `turntable doctor` for a read-only readiness check before going live, see [Doctor](https://github.com/nc9/turntable/blob/main/docs/doctor.mdx).

## 2. Data directory and master key

- `TURNTABLE_DATA_DIR` holds `turntable.db`. Put it on a volume.
- The master key seals every stored secret. With a shell: `turntable keys init --file /data/master.key`, then set `TURNTABLE_MASTER_KEY_FILE`. With no shell, set `TURNTABLE_MASTER_KEY_AUTOINIT=1` and the server creates it once and never overwrites it.
- The key must be readable by user `65532` in the image.

## 3. Public URL and proxies

- Set `TURNTABLE_PUBLIC_URL` to the https address people use. Check links, WebAuthn and the GitHub App use it.
- Behind a TLS proxy, set `TURNTABLE_TRUST_FORWARDED_PROTO=1`.
- Set `TURNTABLE_TRUSTED_PROXIES` only to the address ranges your platform documents for its edge. An entry that is too wide lets a caller spoof its address. Leave it unset if you do not know them. See [Hosted deployment](https://github.com/nc9/turntable/blob/main/docs/hosted.mdx).

## 4. Bootstrap tokens (hashes only)

On the operator's own machine, not on the server:

```sh
turntable token generate            # token on stdout, sha256 on stderr
turntable token generate --instance # an instance-administrator token
```

The human keeps the token and gives you only the sha256. Set it on the server:

- `TURNTABLE_BOOTSTRAP_TOKEN_SHA256` creates one operator token in an org that has none (org `TURNTABLE_BOOTSTRAP_ORG`, default `local`).
- `TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256` registers an instance token if none is active. It expires in 30 days at most.

**Rotate, then remove the variable.** The human calls `POST /api/v1/instance/tokens/rotate` once with the bootstrap token (operation `rotate_instance_token`, also `turntable token rotate <id> --instance`) and keeps the new secret. Then remove the hash variable from the server. See [Instance administrator](https://github.com/nc9/turntable/blob/main/docs/instance-admin.mdx#bootstrapping-with-no-shell).

With a shell on the host, `turntable token create --org <slug> --role operator --name <name>` mints org tokens directly, and the human reads the secret from stdout into a file.

## 5. First org, project, provider and caps

- The default org is `local`. Add a project to a running instance with `create_project` (instance token, REST only), see [Hosted deployment](https://github.com/nc9/turntable/blob/main/docs/hosted.mdx#adding-a-second-repo-to-a-running-instance).
- Choose a provider with `TURNTABLE_PROVIDER` (`docker` or `daytona`) and run jobs with `TURNTABLE_WORKER=1`, see [Providers](https://github.com/nc9/turntable/blob/main/docs/providers.mdx). A provider config never holds a key: it names the environment variable that does.
- Cap load with `TURNTABLE_GLOBAL_CAP` and `TURNTABLE_ORG_CAP`.
- A shared multi-tenant instance sets `TURNTABLE_HOSTED=1`, which refuses container providers.

## 6. Settings

Precedence is environment, then `turntable.toml` (`TURNTABLE_CONFIG`), then the database, then the default. Environment and TOML values lock a setting: the set operations refuse it. See [Configuration](https://github.com/nc9/turntable/blob/main/docs/configuration.mdx#settings-registry).

## 7. Backups, upgrades and rollback

- `turntable db backup` (operation `db_backup`) writes a consistent copy under `<data-dir>/backups/`. SQLite only: use `pg_dump` on Postgres.
- Set `TURNTABLE_BACKUP_BEFORE_MIGRATE=1` so an upgrade that migrates takes a backup first.
- Upgrade by running the new binary or image on the same data. Migrations are embedded and run at boot.
- Roll back by stopping the server, restoring the backup over `turntable.db` (delete its `-wal` and `-shm` files) and starting the previous version. There is no live restore.

## Railway

No shell, one volume per service. Follow [Deploy on Railway](https://github.com/nc9/turntable/blob/main/docs/deploy/railway.mdx): mount `/data`, use `TURNTABLE_MASTER_KEY_AUTOINIT=1`, set `TURNTABLE_TRUST_FORWARDED_PROTO=1`, health check `/healthz`, and do not set `RAILWAY_RUN_UID`. Set variables with `--skip-deploys` and redeploy once. The GitHub App comes next: use the `turntable-github-app` skill.
