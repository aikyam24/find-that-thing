# Stage A implementation plan

The user approved starting from `product-spec.md`. Build the manual-save prototype locally with plain JavaScript and no runtime dependencies. No commits, publishing, history import, automatic capture, or embeddings in this stage.

## 1. Capture and local retrieval

- Implement normalized URL identity, SHA-256 record IDs, bounded paragraph chunks, and original excerpts.
- Add IndexedDB storage with transactional revision changes on saves/deletions.
- Implement weighted local text retrieval over titles, chunks, and notes; exclude zero-score candidates from local results.
- Focused checks: deduplication preserves meaningful URL parameters; late source passages can be found; unrelated queries produce no matches.

## 2. Jev ranking

- Send only the query, title, opaque ID and at most two passages per candidate.
- Validate score bounds, choices, and returned passage IDs. Use a 30-page cap, three requests in flight, and an eight-second deadline covering response parsing.
- Return local results on failure. Cancel superseded searches and prevent deleted or changed records from resurfacing.
- Focused checks: request omits reopening URLs, malformed replies fail safely, and timeouts apply after response headers.

## 3. Extension and interface

- Toolbar activation grants activeTab, saves the page, and opens the search panel. A separate command opens search without saving.
- Build a white/forest-green panel with one search field, original excerpts, and Open / This is the one / Forget actions.
- Provide settings for optional Jev use, explicit disclosure, collection export, key removal, and clearing saved content.
- Use trusted-context messaging and storage; no content script receives a key.

## 4. Focused verification and handoff

- Run the small core suite once after implementation, repeating only for changed behavior or failures.
- Exercise the unpacked extension in an isolated Chromium test profile: capture, retrieve, reload, forget, and settings. Use mocked provider responses for error handling; no private key is copied from Goal Lock.
- Check the actual rendered panel at narrow and wider side-panel sizes. Record what remains unverified.
- Write load-unpacked instructions and current scope in README.
