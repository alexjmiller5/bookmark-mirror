# Bookmark Mirror

A Chrome extension that mirrors life-data bookmarks into native folders on the
bookmarks bar and captures pages with tags. Tag folders sit directly on the
bar, with no enclosing folder. Bookmarks with multiple tags appear in each
matching folder; untagged bookmarks use **Untagged**.

## Connect

1. Install the extension and open **Settings** from its popup.
2. Enter your life-data hub endpoint and a dedicated token with
   `tables:read:bookmarks,tables:write:bookmarks` grants.
3. Allow access to that specific endpoint and choose **Save and connect**.

The hub must support the scoped rows API and
`GET /v1/catalog/options?table=bookmarks&column=tags`. A failed or incomplete
read never becomes an empty mirror. Tokens are kept in the extension's local,
trusted-context storage, not synced to other browsers. Connect each browser
profile separately; revoke its dedicated token to disconnect it.

Sync runs at startup, every five minutes while Chrome is running, and when you
choose **Sync now**. The popup reports the last successful sync and any error.
To capture a page, open the popup, enter a brief description, select tags and
save. New bookmarks created with Chrome’s own star button appear in a review
queue in the popup, with a badge indicating the number waiting. Select one,
add a summary and tags, and save explicitly. Existing bookmarks are not imported
retroactively, and the mirror’s own creations never enter this queue.
Catalog validation remains authoritative. Existing URLs retain their
existing tags when additional tags are captured.

## What changes in Chrome

Existing personal bookmarks are preserved. A matching existing tag folder can
be reused, but its preexisting children are never claimed or deleted. Only
links created and tracked by this extension are updated or removed when their
source changes. User edits or moves release those links from ownership; the
source copy is recreated separately. No folder containing foreign content is
recursively removed. Mirror ownership is saved after each successful change.

Life-data is authoritative for mirrored links. Edit source tags in life-data;
deleting a mirrored Chrome link does not delete its source and it is recreated
on the next sync. Use the popup for explicit capture back to life-data.
Missing titles fall back to descriptions or URLs. Rows lacking a URL are
skipped; any prior managed copy is preserved rather than inferred deleted.

## Development and installation

No runtime dependencies or compilation: `extension/` contains the complete
Manifest V3 package. Use Bun for tests.

```sh
just test
just check
just build
nix build
```

The Nix package installs `share/bookmark-mirror`. Its exported Home Manager
module supports `programs.bookmark-mirror.enable = true` and provides stable
files at `$XDG_DATA_HOME/bookmark-mirror` (normally `~/.local/share/bookmark-mirror`)
for Chrome's **Load unpacked** action. This is an installed directory, not a
symlink into a versioned package: Chrome retains the same path across updates.
After activating a package update, reload the extension in `chrome://extensions`.
Installation into a browser profile uses Chrome's supported interface, and
machine policy must permit the extension. Reenroll the hub credential on a
replacement machine.

For manual installation, extract `dist/bookmark-mirror.zip` (or the ZIP from a
GitHub release) into a permanent directory outside the checkout. Open
`chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select the directory containing `manifest.json`. Keep that directory in place.
To update, replace its contents with the new package and click **Reload** on
Bookmark Mirror's extension card. Do not remove the extension: keeping the same
extension ID preserves its connection settings and bookmark ownership records.
The manifest public key keeps the ID stable across installation paths.

Version tags run the tests and publish the ZIP as a GitHub release. No Chrome
Web Store account, contact email, submission, or review is required.

## Local demo

Use a fresh Chrome profile for this isolated demo. From the repository root,
with Bun installed, start the fixture hub:

```sh
bun scripts/review-hub.js
```

In the extension's **Settings**, enter:

- Endpoint: `http://127.0.0.1:8788`
- Fixture credential: `review-only-not-a-secret`

This credential is public and nonsecret, and works only with this review
harness. Choose **Save and connect**, allow the localhost endpoint permission,
and choose **Sync now**. Three synthetic `example.com` bookmarks appear in
**Reading**, **Research**, and **Untagged** folders; the research bookmark is
present in both tagged folders. The untagged bookmark demonstrates title
fallback to its description.

To test capture, visit `https://example.com/`, open the extension popup, enter
a short description, select **Research**, and save. Sync again: the existing
example bookmark retains **Reading** and also appears under **Research**.
Capture writes affect only the fixture hub's in-memory rows. Repeated syncs
should not duplicate unchanged mirrored links.

Stop the hub with Ctrl-C. Restarting restores the original fixtures; the next
sync reconciles the extension's managed demo bookmarks. The harness never
reads a real hub, uses personal credentials, or writes rows to disk. It is a
development/review tool, not part of the extension runtime or a hosted service.
It refuses nonloopback bindings. If port 8788 is occupied, run
`bun scripts/review-hub.js --port 8789` and use that port in Settings.

## Privacy and licensing

No analytics, remote scripts, or third-party bookmark storage. See
[privacy policy](PRIVACY.md). The bookmark icon is from
[Tabler Icons](https://github.com/tabler/tabler-icons), MIT licensed and
retrieved through Iconify. Icon license is in `extension/icons/LICENSE`.
