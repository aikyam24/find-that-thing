# Find That Thing

Product and technical specification

Status: proposed design for a new browser extension. This document describes intended behavior, not implemented or measured capabilities. All limits, quality thresholds, and performance budgets below are initial targets to validate.

## 1. The product in one sentence

**Find a page you saw before by describing what you remember about it.**

Product direction clarified : **Jev is the core matching engine.** Local retrieval narrows the collection to plausible candidates, then Jev evaluates which pages fit the remembered description. The bounded workload targets speed and efficiency. Local-only search provides a fallback when Jev is unavailable or deliberately disabled; measured latency, cost, and recovery quality must substantiate the intended benefit.

You remember the idea, but not the website or title:

> “That tool that lets me send large files without signing up.”

Open the extension, type that description, and get a few recognizable pages from your own collection, with original excerpts that help you identify the right one.

The primary action is **open the page I meant**. The product should feel like a search box, not a conversation.

### The problem it solves

People encounter useful tools, articles, tutorials, products, and discussions while doing something else. Later, they remember a detail but cannot recover the page. They may not have bookmarked it, may have forgotten the bookmark's title, or may be searching with different words than the original author used.

The product turns that partial memory into a useful search over material the user has actually encountered.

### Example searches

| What someone types | What the product should help recover |
| --- | --- |
| “A file-sharing tool that didn't require an account” | A previously captured product page describing account-free transfers |
| “The explanation of database indexes using a library analogy” | An article containing that analogy |
| “That tutorial about fixing microphone permissions” | A tutorial whose captured text covers the problem |
| “A keyboard with quiet switches I looked at” | A saved product page mentioning quiet switches |
| “The page about refunds on that travel site” | The relevant captured policy page |

Descriptions involving color, layout, photographs, or video content are outside the first version unless the detail also appears in captured text. The extension must not imply that it has visual memory.

## 2. Who it is for

Start with people who regularly look up tools, tutorials, and reference material on desktop Chrome. They already experience the problem and can judge whether a result is correct without a complex workflow.

The first pilot can include developers, designers, students, and researchers. Use ordinary browsing tasks rather than tailoring the product exclusively to one profession.

### The habit to create

1. Encounter something useful.
2. Save it with one action, or let a previously enabled site rule capture it.
3. Forget its name.
4. Recover it by typing what you remember.

Repeat use should come from successful recovery. Do not add streaks, a feed, or a dashboard merely to increase engagement.

### What success feels like

> “I didn't remember the name, but it found the exact page in a few seconds.”

## 3. The most important scope distinction

**Browsing history is not a copy of the pages you visited.** Chrome's history API exposes metadata such as URL, title, and visit information; it does not supply historical page bodies. An import can create title-and-URL records, but cannot reconstruct old content. [Chrome history API](https://developer.chrome.com/docs/extensions/reference/api/history)

Use three clearly named record types:

| Record type | What is available | How it should appear |
| --- | --- | --- |
| Saved page | Text captured when the user explicitly saved it | “Saved Sep 18” |
| Captured page | Text captured under an enabled site rule | “Captured Sep 18” |
| History-only page | Imported title, URL, and available visit metadata | “Title and address only” |

Do not advertise “search everything you have ever read.” The honest initial promise is “search pages you've saved,” expanding to “search pages captured on your chosen sites.”

## 4. Delivery stages

### Stage A: prove that the search is useful

Build a local Chrome extension with:

- One-click saving of the current page.
- A search box in a side panel.
- Local text search.
- Jev-assisted ranking of a bounded candidate set.
- Original page excerpts in the results.
- Open, forget, and “this is the one” actions.
- A user-supplied Jev API key.
- Local storage and export/delete controls.

Use a small collection for this experiment. No automatic capture, history import, accounts, sync, or billing is required to test the core interaction.

### Stage B: make it useful every day

Add:

- Optional automatic capture on individually enabled sites.
- Local semantic retrieval so differently worded memories can find candidates.
- Optional, limited history import with explicit metadata-only labels.
- Date and site filters.
- Storage usage, retention, and capture exclusions.
- Quality and performance validation on larger collections.

This is the first version suitable for a broader pilot. Manual saving alone leaves the product close to a bookmark search tool; selective automatic capture is the path toward the everyday recovery promise.

### Later, only if users need it

- Bookmark import.
- Cross-device synchronization.
- More languages, after evaluation on those languages.
- Local PDF text capture through a separate supported flow.
- Optional local-only semantic search without Jev.
- Multiple snapshots of a page that changes over time.

### Explicitly outside initial scope

- Searching the public web for pages the user has never encountered.
- Generating answers or article summaries.
- Recording screenshots, video, audio, or keystrokes.
- Capturing private messages, email, or banking pages automatically.
- Team knowledge bases, shared collections, and enterprise search.
- Crawling every imported history URL in the background.
- Automatically deleting browser tabs or modifying browser history.

## 5. User experience

### First run

1. Show the promise: **“Remember the idea. Find the page.”**
2. Explain that the collection lives in this browser profile.
3. Explain separately that Jev-assisted search sends the query and selected page excerpts to TypeSafe.
4. Guide the user through adding a Jev key and explicitly enabling Jev search as the intended experience. Keep local search available before setup and as a fallback.
5. Invite the user to save one real page and try a description of it.

Do not request browsing-history access or broad website access during the initial setup.

### Saving a page

Provide an explicit extension action or keyboard command named **Save this page**. Successful capture gives a short confirmation. An optional “What might you remember this for?” note can improve retrieval, but must never be mandatory.

Opening the search panel and saving a page are distinct actions. The implementation must ensure saving runs from an actual user gesture that grants access to the target tab, rather than assuming a panel opened earlier still has access. Chrome's `activeTab` permission provides temporary access following supported user invocation; it is not general background access. [Chrome activeTab documentation](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

### Searching

Placeholder:

> Describe the page you remember…

After submission:

1. Show local matches as soon as they are available.
2. Show a small “Checking matches…” state while Jev ranking runs.
3. Replace or reorder the result list once, preserving keyboard focus.
4. Show up to five primary results, followed by a “More matches” action.

Search runs on submission in the first version. Do not make provider calls on every keystroke.

### Result card

```text
Send large files without an account
example.com · Saved Sep 12

“Share files with a link. Recipients and senders do not
need to create an account…”

[Open page]  [This is the one]  [Forget]
```

The example is illustrative. Real result titles and excerpts must come from stored records. Do not generate a title or quote to make a result appear more convincing.

Show capture time separately from imported last-visit time. A page can have been visited again without its content being recaptured.

### Empty and incomplete states

| Situation | User-facing behavior |
| --- | --- |
| Collection is empty | “Save a page to start finding things here.” |
| Nothing looks relevant | “No strong match in your saved pages.” Offer site/date filters or different wording. |
| Only history metadata exists | “These matches use titles and addresses; page text wasn't captured.” |
| Jev is unavailable | Keep local results and show “Showing local matches.” |
| Page capture failed | Explain the reason, such as unsupported page or no readable text. |
| Original page is gone | Keep the stored excerpt available without claiming a full archived copy. |

Never silently turn an empty personal search into a public web search.

### Accessibility and interaction

- Keyboard operation for search, result navigation, opening, and dismissal.
- Visible focus, readable contrast, and text status labels.
- No meaning conveyed exclusively by color or probability percentages.
- Preserve the query when the panel is reopened.
- Do not persist search history by default; retain the current query only for the session.

## 6. Capture and content handling

### What to capture

- Original URL, stored locally for reopening.
- Normalized identity used for deduplication.
- Title and hostname.
- Main readable text.
- Section or paragraph boundaries.
- User-selected text when explicitly saved.
- Optional user note.
- Capture timestamp, source, and extraction version.

Prefer main-content extraction over blindly taking the first part of `document.body.innerText`. Menus, cookie notices, and footers can otherwise dominate the searchable content.

Initial capture ceiling: 50,000 text characters per page, split into paragraph-aware chunks of approximately 800–1,500 characters. Treat these as tuning parameters. Preserve selected text and mark truncated records explicitly. Queries about omitted content may fail; the UI and quality evaluation must account for that.

### What not to capture

- Form values, passwords, editable drafts, and contenteditable regions.
- Cookies, authentication headers, or browser storage from the page.
- Hidden elements and script/style contents.
- Cross-origin frames in the first version.
- Incognito activity; configure the extension as unavailable there.

An extraction filter cannot guarantee removal of every sensitive detail. Default capture scope and user control are the primary protections.

### Automatic capture in Stage B

Users enable a specific site through **Remember pages from this site**. Request the necessary host access at that moment. Keep a visible list of enabled and excluded sites.

Capture only a top-level page that has been active and visible for a short dwell period, initially ten seconds. Dwell is a heuristic for skipping accidental visits, not proof that the user read the page.

For single-page applications, observe route changes and debounce recapture. Recheck the current URL, site permission, exclusion rules, and capture-enabled state immediately before extraction and before persistence.

Default exclusions include account/security pages, email, messaging, payments, and known sensitive areas. Explicitly allowed sites may still contain private content; provide an obvious pause control and per-site forgetting.

### Deduplication

Normalize conservatively. Remove fragments and known tracking parameters for identity comparison only when they do not identify different content. Preserve meaningful query parameters. Do not treat the page's canonical link as unquestionable authority across domains.

Maintain one current snapshot per URL identity in the first version. Update content only after a successful recapture. Store a content hash to avoid repeating indexing work when the text is unchanged.

## 7. Search architecture

### Why Jev should not search the entire library on every query

The collection may contain thousands of pages. Sending all of them would increase exposure, cost, and latency. First retrieve plausible candidates locally, then ask Jev narrow questions about those candidates.

TypeSafe recommends keeping deterministic work in code and using narrow judgments over relevant state. This design uses Jev for assessing candidate relevance, not generating new pages or controlling browser actions. [TypeSafe design guidance](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)

### Search pipeline

```text
Description + optional site/date filters
                 |
                 v
Local candidate retrieval
  - lexical search over titles, notes, and chunks
  - semantic search over local embeddings in Stage B
                 |
                 v
Merge candidates, remove duplicates, select passages
                 |
                 v
Jev evaluates bounded candidate packets
                 |
                 v
Application validates results and ranks existing records
                 |
                 v
Original excerpts + links in the side panel
```

### Step 1: local retrieval

Use a lexical index with stronger weights for title, user note, and selected text. Support exact phrases and explicit date/site filters.

In Stage B, add local embeddings for captured chunks and the query. Merge lexical and vector rankings with a method such as reciprocal rank fusion. This avoids combining raw scores whose scales are unrelated.

Choose a compact, locally executable text embedding model during an isolated compatibility experiment. Selection gates: redistribution license, Manifest V3 compatibility, measured memory use, CPU fallback, and retrieval performance on the evaluation set. Package executable inference code with the extension; do not load remote executable scripts.

For the initial browser implementation, run local inference in a dedicated worker owned by the open extension UI. Persist pending indexing jobs; resume them when that UI is available. Automatic capture can persist text while embeddings are pending. Show the index status and continue lexical search in the meantime. A separate background inference architecture can follow only if the queue proves disruptive.

### Step 2: build a bounded shortlist

Initial target: up to 30 distinct pages, with at most two relevant chunks per page. Include a mix of lexical and semantic candidates, and prevent many chunks from one page consuming the whole shortlist.

For the small Stage A pilot, if lexical retrieval produces weak candidates, offer **Search more saved pages**. It may examine a bounded additional set, initially no more than 100 pages total per search. Make this a deliberate expansion, not an unbounded provider loop.

Jev cannot recover a page that local retrieval never includes. Measure candidate recall separately from final ranking. If paraphrased queries fail candidate retrieval, local semantic retrieval becomes a release requirement rather than an optional enhancement.

### Step 3: Jev ranking

For each candidate, send only the query, title, an opaque candidate ID, and selected text passages. Include a hostname only when useful; keep full URLs and their query strings local.

Ask separately:

1. How closely does this candidate match the remembered page? Use an ordered relevance rubric.
2. Is the distinctive detail in the query supported, contradicted, or not established by the supplied passages?
3. Which supplied passage best helps the user recognize the match? Choose from existing passage IDs, including “none.”

Batch size and concurrency must be bounded by the current account and model limits. Start with one candidate per evaluation and at most three requests in flight for clarity; benchmark small shared-state batches before adopting them. No throughput or cost claim is made by this design.

### Step 4: compose the result in code

- Use relevance as the primary ordering signal.
- Preserve uncertainty rather than presenting every top result as certain.
- Treat a missing detail differently from an explicit contradiction.
- Use local retrieval rank and recency as tie-breakers, not evidence of correctness.
- Keep history-only records distinguishable from content-backed matches.
- Do not infer “95% chance this is your page” from a provider confidence value.

Choice and Score confidence is derived from the returned distribution. Thresholds should be evaluated on this product's examples; they are not universal accuracy guarantees. [TypeSafe confidence documentation](https://docs.typesafe.ai/confidence)

### Step 5: show existing evidence

Resolve the selected passage ID against stored chunks. Reject unknown IDs. Display exact source text, safely escaped, with optional deterministic keyword highlighting.

One limitation remains even with good ranking: the page may no longer say what it said at capture time. Present snippets as saved text and opening a link as viewing the live page.

## 8. Jev contract

The documented integration uses state plus typed questions. Use an HTTP adapter with a configurable model alias and explicit response validation. Verify the endpoint contract against the enabled account during implementation. [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart)

Illustrative application state:

```json
{
  "query": "The file-sharing tool that did not require an account",
  "candidate": {
    "id": "page_42",
    "title": "Example Transfer",
    "sourceQuality": "captured_text",
    "passages": [
      {
        "id": "chunk_42_3",
        "text": "Send files with a link. No account is required."
      }
    ]
  }
}
```

Proposed questions:

| Question ID | Primitive | Proposed criteria |
| --- | --- | --- |
| `relevance` | Score | unrelated; loosely related; plausible match; strongly matches the described page |
| `detail_support` | Choice | supported; contradicted; not established; no distinctive detail in query |
| `best_passage` | Choice | supplied passage IDs; none |

The application-normalized result might be:

```json
{
  "candidateId": "page_42",
  "relevance": 3,
  "relevanceConfidence": 0.86,
  "detailSupport": "supported",
  "bestPassageId": "chunk_42_3",
  "modelVersion": "provider-reported-version"
}
```

These numbers are illustrative. This is an internal result shape, not a claim that the provider returns exactly this JSON. The adapter maps validated provider responses into it.

Validate numeric bounds, finite values, required fields, allowed choices, candidate ownership, and passage membership. Treat missing answers as unavailable; never invent defaults that make a page look relevant. Use strict parsing instead of accepting arbitrary lookalike response fields.

Page content is untrusted data. It must not change the query, rubric, permissions, or allowed actions. A malicious page may still influence a model's ranking; therefore, model output only affects search ordering and selection among stored passages.

## 9. Extension components

| Component | Responsibility |
| --- | --- |
| Side panel | Search, results, capture status, filters, feedback |
| Options page | Jev key, privacy, site rules, retention, export/delete |
| Capture script | Extract approved top-level page content |
| Service worker | Permission checks, capture coordination, provider requests, message validation |
| Local database | Page records, chunks, vectors, jobs, and deletion state |
| Retrieval module | Lexical and semantic candidate search |
| Jev adapter | Request limits, timeouts, parsing, and normalized decisions |
| Indexing worker | Local embedding and index construction while UI is available |

Proposed folder structure:

```text
find-that-thing/
  manifest.json
  background.js
  content/capture.js
  sidepanel.html
  sidepanel.js
  options.html
  options.js
  ui.css
  lib/
    db.js
    records.js
    extract.js
    url-identity.js
    retrieval.js
    search-policy.js
    typesafe.js
    privacy.js
  workers/indexer.js
  assets/
  tests/
```

Prefer plain JavaScript modules initially to keep the extension structure small. A framework is optional and should follow interface needs rather than drive them.

### Permissions by stage

Stage A is expected to need `storage`, `sidePanel`, `activeTab`, `scripting`, and access to the TypeSafe API origin. Register a save command as needed. Verify the chosen gesture flow with the actual browser APIs before finalizing the manifest.

Stage B adds optional website host access and optional `history` access only when those features are enabled. Avoid requesting `tabs` solely for functionality already available through the chosen temporary or host permissions. Document every final permission and test its removal.

### Service worker reliability

Persist durable state and indexing checkpoints. Do not assume that globals or a long-running timer survive. Chrome extension service workers can terminate between events. An interrupted search should return local results and offer an explicit retry, rather than replaying paid requests automatically on every restart. [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)

## 10. Local data model

### Page record

```ts
type PageRecord = {
  id: string;
  schemaVersion: number;
  originalUrl: string;
  normalizedIdentity: string;
  hostname: string;
  title: string;
  source: 'manual' | 'site_capture' | 'history_only';
  createdAt: number;
  capturedAt: number | null;
  lastVisitedAt: number | null;
  expiresAt: number | null;
  contentHash: string | null;
  extractorVersion: string | null;
  truncated: boolean;
  userNote: string | null;
  indexingStatus: 'pending' | 'ready' | 'failed' | 'metadata_only';
};
```

### Supporting records

- `Chunk`: page ID, chunk ID, ordinal, text, and character offsets.
- `Embedding`: chunk ID, vector, model ID, and embedding version.
- `IndexJob`: page ID, source content hash, state, and retry count.
- `Settings`: capture rules, exclusions, retention, provider configuration, and local-only mode.
- `SearchFeedback`: optional local record linking a query to a user-confirmed result; off by default.
- `DeletionGeneration`: incremented when data is forgotten or cleared, so stale asynchronous work cannot recreate it.

Store page bodies, chunks, and vectors in IndexedDB. Store small preferences and the provider key in extension storage. Restrict key access to trusted extension contexts; never send it to content scripts. Chrome documents extension storage access levels and differences between local, session, and sync storage. [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)

Do not describe local extension storage as encrypted or immune to device compromise. The initial product has no account or backup; uninstalling the extension or losing the profile can lose the collection. Provide an explicit export flow with a warning that exports contain browsing content.

## 11. Privacy and deletion behavior

### Data flow disclosure

| Data | Stored locally | Sent to TypeSafe during assisted search |
| --- | --- | --- |
| Complete captured page text | Yes, within capture limit | No; selected passages only |
| Selected candidate passages | Yes | Yes |
| Search description | Session by default | Yes |
| Title | Yes | Yes, for shortlisted candidates |
| Full reopening URL | Yes | No |
| Hostname | Yes | Only when needed |
| Unrelated pages and browsing history | Yes, if enabled/imported | No |
| Jev key | Extension settings | As authentication to the provider |

“Stored locally” must not be presented as “nothing leaves your device.” Provider retention and training policies must be checked and accurately disclosed before release; do not assume zero retention.

### Controls

- Pause capture immediately.
- Disable capture for a site.
- Forget one page or all pages from a site.
- Clear the full collection.
- Remove the Jev key and use local search.
- View enabled sites and approximate storage use.
- Export saved content deliberately.

### Retention proposal

Manually saved pages remain until removed by the user. Automatically captured and history-only records expire after 90 days by default. Let users choose a shorter period. Enforce expiry on startup and regular database maintenance, not only when a specific page is opened.

### Deletion contract

Forgetting a page removes its text, vectors, index entries, derived caches, and feedback references. In-flight responses must check record existence and deletion generation before updating the UI or database.

Disabling a site stops new capture. Offer a separate action to remove its existing records. A persistent exclusion should prevent new automatic capture; an explicit manual save can require a clear override.

If history import is enabled, handle browser-history deletion events by removing the corresponding imported records. Clearing all history removes all imported records. Explicitly saved and separately captured content follows the extension's own deletion controls; disclose this distinction. Never delete the user's browser history as a side effect of forgetting an extension record.

Deleting local records cannot retract excerpts already sent to a provider. Keep that limitation explicit.

## 12. Cost, latency, and failure handling

### Initial operating limits

| Setting | Starting target |
| --- | --- |
| Jev candidate pages per ordinary search | Up to 30 |
| Relevant chunks per candidate | Up to 2 |
| Concurrent provider calls | Up to 3 |
| Overall assisted-search deadline | 8 seconds |
| Local result display | p95 under 300 ms on the reference collection/device |
| Assisted result display | Target p95 under 5 seconds after submission |
| Expanded search | Explicit action, capped at 100 total pages |

These are product budgets, not expected provider performance. Measure before promising speed.

Track actual request count, token usage when returned, latency, and estimated cost using current provider prices. Record the pricing date. Do not bake an unverified advertised cost into a subscription plan.

Cancel superseded searches, keep an operation ID for each query, and ignore late results from old queries. Abort where supported, while recognizing that canceling locally may not prevent a provider charge.

For invalid credentials, show a settings action. For rate limits or transient failure, retain local results and offer retry. Keep retries bounded by the search deadline and avoid duplicate retry layers.

Do not persist provider response caches containing queries in Stage A. If later introduced, make them short-lived and invalidate by query, content hash, rubric version, and model version.

## 13. How to prove that it works

### Evaluation collection

Build a consented test collection of at least 200 pages and 60 queries for the initial experiment. Include:

- Exact-name and exact-phrase queries.
- Descriptions using synonyms absent from the title.
- Queries involving negation, such as “without an account.”
- Several similar products with one distinguishing feature.
- Multiple pages on the same website.
- History-only records.
- Long pages whose relevant passage appears late.
- Pages with navigation noise or incomplete extraction.
- Queries where the desired page is not in the collection.

Have people write queries from memory after a delay, rather than deriving all queries from visible page text. Split development and held-out examples so rubric tuning does not leak into the final evaluation.

### Compare these systems

1. Title/URL keyword search.
2. Local full-text search.
3. Local lexical plus semantic retrieval.
4. The same retrieval with Jev ranking.

Use the local baselines to measure Jev's contribution to recovery quality, latency, and cost. If the Jev workflow misses these targets, improve candidate retrieval and ranking before claiming the intended speed and efficiency benefits. Local fallback alone does not establish that the Jev-powered product goal has been met.

### Metrics

| Metric | What it answers |
| --- | --- |
| Candidate recall at 30 | Did retrieval include the correct page before Jev saw it? |
| Success at 1 and at 5 | Was the correct page near the top? |
| Time to confirmed recovery | Did the person find it faster? |
| False strong-match rate | Did the tool appear confident when the page was absent? |
| Excerpt recognition | Did the displayed passage help identify the page? |
| Latency and cost per search | Is assisted ranking practical? |
| Repeat successful use | Does it become a habit after the novelty wears off? |

### Initial pilot gates

- Target candidate recall at 30 of at least 90% for captured-text queries.
- Target correct-page presence in the top five of at least 80% on held-out queries.
- Target at least a ten-percentage-point top-five improvement over full-text search on paraphrased queries to demonstrate Jev's ranking benefit.
- Target false strong-match rate below 10% on absent-page queries.
- Validate latency on a stated device and collection size, including cold indexing and provider failures.

These gates are provisional. Report sample counts and error examples alongside percentages. A small pilot cannot establish general accuracy.

For habit testing, ask five to ten users to use it for two weeks. Look for successful searches they initiate themselves. “People saved many pages” is not enough evidence that the product helps recover them.

## 14. Engineering acceptance checklist

### Capture and storage

- [ ] A manual save creates a reopenable record with original text.
- [ ] A repeated save does not produce accidental duplicates.
- [ ] A meaningful content change replaces the snapshot and reindexes it.
- [ ] Truncation and metadata-only records are visible.
- [ ] Unsupported pages fail clearly.
- [ ] Form fields, drafts, and hidden content are excluded by tested extraction rules.
- [ ] An extension restart preserves saved records and resumes pending index work.

### Search and Jev

- [ ] Keyword matches work without a provider key or network.
- [ ] Paraphrased queries meet the chosen candidate-recall gate.
- [ ] Every displayed quote maps to a stored source passage.
- [ ] Invalid and incomplete provider responses cannot create misleading results.
- [ ] A new query supersedes old requests without stale results replacing it.
- [ ] Rate limits, timeouts, and invalid credentials preserve local search.
- [ ] Search cost and request limits are enforced.

### Privacy and control

- [ ] No capture occurs on sites without the required user action or permission.
- [ ] Pausing capture prevents both extraction and subsequent persistence.
- [ ] Full URLs and unrelated records do not enter provider payloads.
- [ ] Keys are inaccessible to page scripts and capture scripts.
- [ ] Forgetting content clears all derived local artifacts.
- [ ] In-flight operations cannot resurrect deleted content.
- [ ] Revoking optional permissions leaves a usable manual/local experience.

### Interface

- [ ] A user can save, search, and open a result using the keyboard.
- [ ] Empty, incomplete, offline, and failure states are understandable.
- [ ] Search results remain readable and usable without color cues.
- [ ] A title-only result never appears to have captured-body evidence.

## 15. Build order and checkpoints

### Phase 1: capture and reopen

Implement the smallest extension shell, explicit capture gesture, local database, and saved-page list. Verify extraction on an article, product page, documentation page, and single-page application.

**Exit:** saved text and URLs survive a restart, and forgetting removes them.

### Phase 2: local search

Add chunking, indexing, query submission, result cards, and exact excerpts. Establish the keyword and full-text baselines before introducing Jev.

**Exit:** baseline metrics exist and searches work offline.

### Phase 3: Jev-assisted ranking

Add key settings, bounded candidate evaluation, strict parsing, timeout behavior, and provider payload inspection. Run the same held-out queries.

**Exit:** measurable benefit over baseline, or a documented decision to revise the approach.

### Phase 4: semantic retrieval and everyday capture

Validate a local embedding runtime, then add optional per-site capture, filters, retention, and indexing progress. Add metadata-only history import only after capture and search are reliable.

**Exit:** larger collections meet recall, privacy, and performance gates.

### Phase 5: small external pilot

Package onboarding, export/delete, diagnostics, and accurate data-flow disclosures. Run the two-week habit test. Verify current store requirements and provider terms before distribution.

**Exit:** users repeatedly recover real pages and the product's main failure modes are understood.

## 16. Product decisions to revisit after evidence

| Decision | Initial position | What could change it |
| --- | --- | --- |
| Platform | Desktop Chrome | Repeated demand for another browser |
| Capture | Manual first; site-specific opt-in next | Habit testing shows excessive saving friction |
| Storage | Local to one browser profile | Users need multi-device recovery |
| Provider access | Bring your own Jev key for pilot | Nontechnical users cannot complete onboarding |
| Ranking | Local shortlist, then Jev | Benchmark shows no meaningful benefit |
| Embedding model | Select through compatibility and recall tests | Device constraints or language requirements |
| Monetization | Defer until successful recovery is demonstrated | Repeat usage and measured operating cost |

Avoid claiming unique market positioning without competitor research. The product hypothesis is specific: **a short description plus recognizable source excerpts makes recovering a previously encountered page easier than the user's current method.**

## 17. First concrete milestone

Build a version where someone can save 20 real pages, return the next day, type five descriptions from memory, and recover the intended page from the first five results.

That experiment should answer three questions before the product expands:

1. Do people describe their memories in a way the system can match?
2. Does Jev improve the order enough to matter?
3. Do the original excerpts help people recognize the correct page quickly?

If those answers are positive, expand capture and retrieval. If not, improve the recovery experience before adding accounts, integrations, or a business model.
