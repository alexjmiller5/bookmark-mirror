# Bookmark Mirror privacy policy

Bookmark Mirror reads bookmark data from the life-data endpoint you configure
and writes corresponding folders and links into your Chrome bookmarks bar.
When you explicitly capture a page, its URL, title, description and selected
tags are sent only to that endpoint.

The extension uses bookmarks permission to reconcile its managed links,
storage permission to remember settings and ownership, alarms permission for
periodic synchronization, and activeTab permission to prefill a capture after
you open its popup. Host access is requested only for the endpoint you choose.

The endpoint credential, ownership records and last sync status are stored
locally in the extension. They are not sent through Chrome storage sync. Your
Chrome account's own bookmark synchronization is controlled by Chrome settings.

The extension does not sell data, collect analytics, display advertisements,
execute remote code, or send data to its developer. It does not read page
content or browser history. Your configured hub's privacy and retention rules
apply to data sent there.

You can revoke the extension's token at your hub and uninstall the extension
to remove its local settings. Uninstalling does not delete bookmarks from
Chrome or rows from life-data. Remove those through their respective user
interfaces if desired.
