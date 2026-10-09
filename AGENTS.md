# Bookmark Mirror

Manifest V3 extension mirroring soma bookmarks into native Chrome tag
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
- Capture uses the hub's rows API and catalog tags; confirm persisted values.
  A later mirror error must not misreport a confirmed capture as failed.
- Native bookmark additions queue for explicit review after serialized mirror
  mutations. Exclude persisted managed IDs, preserve the queue across restarts,
  and never auto-import historical links or write source data without a save.
- Local unpacked distribution through Chrome's Load unpacked interface.
  No Web Store publishing or publisher account required. No analytics.
- Chrome installation/configuration goes through the app's exported Nix
  package/module plus the user's machine config. Never run installed software
  from this checkout.

- Version tags test and publish the installable ZIP to GitHub Releases.
  Build/CI has no provider or hub credentials.
- The loopback-only review hub is an isolated in-memory fixture, never a
  runtime service or a source of production data.
