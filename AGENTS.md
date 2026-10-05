# Bookmark Mirror

Manifest V3 extension mirroring life-data bookmarks into native Chrome tag
folders directly on the bookmarks bar. No enclosing folder. Untagged rows
use an Untagged folder. Existing user bookmarks are preserved.

- Plain ES modules under extension/, no runtime dependencies or build step.
- Tests use Bun; test before implementation. just test/check/build.
- Hub endpoint and table-scoped credential are supplied through options UI.
  Credential stays in chrome.storage.local restricted to trusted contexts,
  never chrome.storage.sync. No provider credentials or personal defaults.
- Only bookmarks tracked as extension-created may be updated/removed.
  Reuse a matching existing bar folder without claiming its existing children.
  Persist ownership after each successful mutation; never recursive-delete
  user content. Missing managed bookmarks are recreated from the source.
- Background alarm and explicit Sync now perform the same serialized sync.
- Capture uses the hub's rows API and catalog tags; validate rejected rows.
- Unlisted Chrome Web Store distribution. Release requires review; a submitted
  release is not live. No analytics.
- Chrome installation/configuration goes through the app's exported Nix
  package/module plus the user's machine config. Never run installed software
  from this checkout.
