---
name: turntable-github-app
description: Create, install and claim the GitHub App for a self-hosted Turntable instance, safely. Use when the user wants Turntable to receive GitHub webhooks, run checks on pull requests, or needs to fix an App that posts no checks, returns 401, or is ignored.
---

# Create the GitHub App

Every instance has its own App. There is no shared App. The docs are the source of truth: [GitHub App](https://github.com/nc9/turntable/blob/main/docs/github-app.mdx) and [Hosted deployment](https://github.com/nc9/turntable/blob/main/docs/hosted.mdx).

## Secret rules (read first)

- Never read, print, type or ask for the setup token, the App's private key, the webhook secret or any other token. The human pastes the setup token into the browser page.
- Never paste a token into a chat. Set only sha256 hashes on the server.
- App credentials are sealed in the encrypted store and never shown. They need `TURNTABLE_MASTER_KEY_FILE`.

## Safety rule: public Apps

**An App is public only in claim mode. A public App without `TURNTABLE_CLAIM_INSTALLATIONS=1` lets anyone who installs it map to your org, auto-create projects and run code on your sandboxes.** Unclaimed installations are ignored by the webhook handler. If other accounts will install the App, set `TURNTABLE_CLAIM_INSTALLATIONS=1` before you make it public, and never the other way round.

## 1. Choose an owner and visibility

- Own the App from an organization you control, with 2FA required. App names are global on GitHub: pick a unique one.
- **Private:** installed only on the account that owns it. No claim mode needed.
- **Public:** other accounts install it. Claim mode is mandatory. After #337 the manifest makes the App public when claim mode is on. Before it, turn on "Make public" by hand, and only after claim mode is set.
- Claim mode also needs **Request user authorization (OAuth) during installation**. The manifest sets the setup URL, not that option: turn it on in the App's settings.

## 2. Create it

**With a shell on the instance host:** `turntable github-app create --url <public url> [--org <github org>] [--name <name>]`. It serves a loopback page, the human approves on GitHub, and the credentials go into the store.

**Hosted, no shell:**

1. On the operator's machine: `turntable token generate`. The token goes in a password manager. Only the sha256 is given to you.
2. Set on the instance: `TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256=<hash>`, `TURNTABLE_PUBLIC_URL=<url>`, `TURNTABLE_MASTER_KEY_FILE`, and for several orgs `TURNTABLE_CLAIM_INSTALLATIONS=1`. Redeploy.
3. The human opens `<public url>/api/v1/instance/github-app/manifest` and enters the token, the owning Turntable org slug, a name and the GitHub org.
4. The human approves on GitHub. Do not edit the App name on GitHub's page: it is checked.

**Stop and ask the human if GitHub's review shows more than this:**

- permissions: checks write; contents, metadata and pull requests read;
- events: `push`, `pull_request`, `check_run`;
- webhook URL `<public url>/api/v1/webhooks/github`;
- setup URL `<public url>/api/v1/github/setup` with OAuth on install (claim mode).

## 3. Remove the setup variable

After the App exists, remove `TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256` from the instance. The route also closes itself after the first success.

## 4. Install and claim

1. The human installs the App and chooses **Only select repositories**.
2. In claim mode, an org token with `release_operator` or admin calls `start_installation_claim` over REST (`POST /api/v1/github/installation-claims`). It is not an MCP tool: a human opens the returned link in a browser and confirms, then installs. The claimer must be an admin of the GitHub org.
3. Repos polled before the install are adopted into the installation after #336. Until then, check that checks post and see the table below.

## 5. Verify

- In the App's **Advanced** tab, recent deliveries are `2xx`.
- `turntable github-app status` lists the App and installations with no secrets.
- A test pull request shows a Turntable check. Checks post only when the project's checks mode is not `off`, see [Quickstart](https://github.com/nc9/turntable/blob/main/docs/quickstart.mdx#report-results-to-github-as-check-runs).

## Troubleshooting

| Symptom                       | Cause                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| The manifest page returns 404 | `TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256` is unset, the route closed, or it is not yet redeployed. |
| No checks post                | The repo binding was not adopted (see #336), or the project's checks mode is `off` or `shadow`.    |
| Deliveries return 401         | The webhook secret is wrong. Run `turntable github-app rotate-webhook-secret`.                     |
| An installation is ignored    | It has not been claimed. Start a claim.                                                            |
| Deliveries return 429         | Bad signatures from one address. Set `TURNTABLE_TRUSTED_PROXIES` correctly.                        |

## Rotate or replace

- Webhook secret: `turntable github-app rotate-webhook-secret`. The old one stays valid for 24 hours.
- Replace the App: run the create flow again asking to replace. The old App's installations and bindings are removed, so install the new App again.
