# Find That Thing

Save a page. Find it later by describing what you remember.

Find That Thing is built around Jev for matching pages to what you remember. Local retrieval selects a small candidate set; Jev evaluates and ranks those candidates. This bounded workflow targets speed and efficiency, with local search available as a fallback.

## Load locally

1. Open `chrome://extensions` (or the equivalent in a Chromium browser).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Pin **Find That Thing** to the toolbar.
5. Open an ordinary web page and click the icon. The page is saved and the search panel opens.

Chrome 116 or newer is required. Other Chromium browsers may differ in side-panel support; validate your browser before relying on it.

## Use

- Click the toolbar icon to save the current page. Clicking it again refreshes the saved copy.
- Describe the page in the panel and press Enter or **Find page**.
- **Open page** opens the original address. Excerpts show the saved text, which may differ from the current page.
- **Forget** removes the extension's record, without touching browser history.
- **This is the one** confirms the result in this session; feedback is not stored or uploaded.
- Open **Settings** to export the collection, clear it, or configure Jev.

Suggested shortcuts: `Cmd/Ctrl+Shift+S` to save and open; `Cmd/Ctrl+Shift+F` to open search without saving. Existing shortcut conflicts can prevent assignment. Settings shows the actual assigned shortcuts.

## Set up Jev search

Jev is the main matching engine for the intended search experience. In the current implementation, add your TypeSafe key in Settings and explicitly enable assisted search to use it. This uses your API allowance and sends the selected content described below to TypeSafe. Local-only search remains available before setup, when deliberately selected, or when Jev is unavailable.

Speed, cost efficiency, and ranking quality are goals to measure; they are not yet established by a live Jev benchmark.

Each assisted search sends the description and selected text passages from up to 30 saved pages to `https://api.typesafe.ai/v1/systemone`. At most three requests run concurrently under an eight-second deadline. An explicit expanded search considers at most 100 pages. Full reopening URLs are not included as fields, but saved page text can itself contain sensitive information and URLs.

Your whole collection is not uploaded. The key is kept in extension storage restricted to trusted extension contexts and never provided to capture scripts. No keys are included in exports. Provider retention is governed by TypeSafe's current policies; this extension does not claim zero retention.

If Jev rejects the key, returns invalid data, is rate-limited, or times out, local results remain available. No automatic retries are performed. Rankings are suggestions, not accuracy guarantees.

## Data and limitations

- Saved pages live in IndexedDB in this browser profile. There is no cloud backup or import yet.
- Search descriptions last for the browser session. Local storage is not an encrypted vault.
- Only top-level readable text is captured, up to 50,000 characters. Forms, editable areas, hidden elements, navigation, and scripts are excluded where identifiable.
- PDFs, screenshots, media, browser-internal pages, and cross-origin frames are unsupported.
- Capture is manual. You cannot search content that was never saved.
- A local keyword shortlist is used initially. Jev also considers a bounded set of saved candidates, but paraphrases may still fail on larger collections. Local semantic retrieval is Stage B.
- A recapture replaces the previous text snapshot. An older remembered detail can be lost.
- Incognito is disabled. There is no browsing-history access.
- Export contains private browsing content. Deleting the extension may delete local records.

## Development

Load the source directly as an unpacked extension. Run the small behavior suite with Node 20+:

```sh
npm test
```

No package installation is needed for the core tests. Browser verification uses an isolated Chromium profile; see `docs/verification.md` for the recorded result and limits.

## Files

- `background.js`: trusted message handling, explicit capture, bounded Jev search.
- `content/capture.js`: page extraction, injected only after an explicit gesture.
- `lib/records.js`, `lib/db.js`: normalized records, chunks, local storage, deletion generations.
- `lib/search.js`, `lib/typesafe.js`: local retrieval, request construction, response validation.
- `sidepanel.*`, `options.*`, `ui.css`: interface and settings.
- `docs/product-spec.md`: full proposal, including later phases.
- `docs/implementation-plan.md`: current Stage A implementation scope.

API references: [TypeSafe Score](https://docs.typesafe.ai/primitives/score), [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice), [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
