# AGENTS.md

Chrome extension (Manifest V3) shipping through the Chrome Web Store —
tag-driven GHA publish, installed on Alex's machines via the nix
`ExtensionInstallForcelist` block (declarative, auto-updating, survives
fresh-machine bootstraps). For personal never-published extensions use the
`chrome-extension` template instead.

## Layout

- `extension/` — the shippable dir: `manifest.json` + plain JS. No build
  step by design; add one (Bun) only when the project needs TS/deps, keeping
  `extension/` as the built output CI zips.
- MV3 only: background logic is a service worker (event-driven, killed when
  idle — persist state in `chrome.storage`, never module globals).
- `.github/workflows/release.yml` — tag `v*` → version check → zip → Web
  Store upload + publish via `chrome-webstore-upload-cli`.

## Publishing model

- **Visibility: Unlisted by default** (direct-link installable, invisible to
  search, still forcelist-compatible). Public listing is an explicit
  decision with real review/support consequences.
- **Deploying = bump `manifest.json` version + commit + `just deploy`**
  (tags and pushes; CI publishes). Verify with `gh run watch <id>
  --exit-status`. Google reviews every submission — hours to days for
  simple diffs, longer for broad permissions; there is no fast lane. The
  workflow succeeding means "submitted", not "live". The version moves only
  in a release Alex asked for; when to release and which number: the
  `semver` skill.
- Permissions: request the minimum — every added permission re-triggers
  deeper review AND re-prompts users.

## One-time Chrome Web Store account setup (first use of this template)

Not done yet as of 2026-08-11. All click-ops, Alex-only:

1. Pay the one-time $5 developer registration at
   https://chrome.google.com/webstore/devconsole (use the personal Google
   account; identity verification may be required).
2. Chrome Web Store API creds (account-level, reused by every extension):
   Google Cloud console → new project → enable "Chrome Web Store API" →
   OAuth consent screen (internal/testing is fine) → create OAuth client
   (Desktop app) → note CLIENT_ID + CLIENT_SECRET → mint a REFRESH_TOKEN
   with the `chromewebstore` scope (the chrome-webstore-upload-cli README's
   token walkthrough is the reference).
3. Store them in ONE shared "Chrome Web Store" 1P item (AI Agent vault or a
   dedicated vault — tag per the 1password skill) with fields CLIENT_ID,
   CLIENT_SECRET, REFRESH_TOKEN. Every webstore-extension project's SA gets
   read on it (same shared-vault pattern as Apple Signing).

## Per-project bootstrap

1. FIRST upload is manual (the API can create drafts but the dashboard flow
   is simpler and sets visibility): `just build`, upload `extension.zip` in
   the dev console, set visibility Unlisted, submit. Note the extension ID.
2. Put the ID in the project's `<Project> ENV` item (field EXTENSION_ID);
   fill `.env.tpl` refs; Alex runs `op-project-bootstrap` (1password skill)
   for the vault/SA/`OP_SERVICE_ACCOUNT_TOKEN` wiring.
3. Add the extension ID to nix-config's `ExtensionSettings` block
   (`hosts/macbook-air.nix`) as a `normal` entry — that's what actually
   installs it on the machines (which run default-deny: an undeclared
   extension can't even be installed manually). Manual installs are for
   non-Nix people.
4. Subsequent releases are pure `just deploy`.

## New-project checklist (delete this section when done)

1. Replace every CHANGEME (`grep -rn CHANGEME .`) — manifest, .env.tpl,
   workflow op:// refs.
2. `just check`, then load unpacked (`just dev`) and verify behavior.
3. Repo: `git init && git add -A && git commit`, `gh repo create <name>
   --private --source . --push`, description + topics (repo-metadata skill).
4. Run the per-project bootstrap above (needs the one-time account setup).
5. Register in the projects skill / Notion Projects DB.
