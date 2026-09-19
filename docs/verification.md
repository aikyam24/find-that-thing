# Verification — 19 September 2026

## Current boundary

Stage A is implemented in source. Browser installation, actual toolbar capture, and live Jev calls are not yet verified. This is a local prototype, not a release-readiness or search-accuracy claim.

## Confirmed

`npm test` passes **5/5 focused behavior checks**:

1. URL deduplication removes known trackers while retaining meaningful query parameters and hash-router paths.
2. Local search finds a relevant passage late in a captured page, displays matching source text, and excludes unrelated keyword results.
3. Jev request packets omit the reopening URL field and limit candidate passages.
4. Invalid scores, missing answers, and invented passage IDs are rejected.
5. A provider response that stalls after headers is stopped by the deadline.

JavaScript syntax and manifest-referenced file presence were checked separately. There is no build step or runtime package install.

A focused source review identified a hidden extraction root bypass: TreeWalker does not filter its root. Capture now checks candidate roots and their ancestors for visibility before choosing one. This correction has been reviewed in source; DOM/browser reproduction remains pending.

## Browser verification blockers

- The cached Chromium executable could not launch because its framework was missing.
- An isolated Brave process also failed to launch under this task's sandbox.
- Opening the local preview in the Codex in-app browser was rejected by its URL security policy. The tool explicitly prohibited alternate access to the same page, so no workaround was attempted after that rejection.

No browser-rendered screenshot, toolbar flow, or IndexedDB end-to-end result is claimed. The user's normal browser profile was not changed and the extension was not installed into it.

## Short manual check

1. Load this folder as an unpacked extension and pin it.
2. On a normal public article or product page, click the toolbar icon. Expect a saved confirmation and the side panel.
3. Search for a distinctive phrase; open the result.
4. Close/reopen the panel and confirm the saved record remains.
5. Forget the page and confirm it disappears.
6. If testing Jev, add a key in Settings and enable assisted search using non-sensitive saved pages. Verify ranking and the fallback message for an invalid key.

Keep further verification focused on these flows. No broad test matrix or additional test framework was added.
