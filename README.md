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
save. Catalog validation remains authoritative. Existing URLs retain their
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
files at `~/.local/share/bookmark-mirror` for Chrome's **Load unpacked** action.
Installation into a browser profile uses Chrome's supported interface, and
machine policy must permit the extension. A managed store installation should
use its Web Store ID once the unlisted listing has been approved. Reenroll the
hub credential on a replacement machine.

`dist/bookmark-mirror.zip` is the store upload. The release workflow submits
version tags through project-owned Web Store credentials in `.env.tpl`.
Submission is not approval: Google review must finish before a store release
is available. The first draft establishes the store extension ID.

## Privacy and licensing

No analytics, remote scripts, or third-party bookmark storage. See
[privacy policy](PRIVACY.md). The bookmark icon is from
[Tabler Icons](https://github.com/tabler/tabler-icons), MIT licensed and
retrieved through Iconify. Icon license is in `extension/icons/LICENSE`.
