# Roadmap

## Phase 1 — Bluesky (the training ground)

Build the entire skeleton against the friendliest target. Tasks are ordered for incremental verification:

1. **Scaffold.** `npm create wxt@latest`, TypeScript strict, side panel entry, content script entry, service worker. `.gitignore`, GitHub Actions release workflow (tag → `wxt build` → zip → GH release).
2. **Messaging RPC.** Tiny typed `chrome.runtime` port wrapper: `call(tabId, method, args) -> Promise<result>`. One file, no framework.
3. **DomPrimitives (Bluesky).** Content script, stateless: `scroll({direction, amount})`, `queryItems({selector}) -> NodeInfo[]`, `openMenu({itemSelector})`, `clickDelete({menuSelector})`, `readState() -> {url, scrollY, modalPresent, bannerText?}`. No business logic.
4. **SelectorMap + shipped Bluesky selectors.** `src/selectors/bluesky.json` v1. Resolution (override → shipped → LLM-heal → pause) + override store in `chrome.storage.local`. Schema-version bump on update discards overrides; logged.
5. **PacingEngine.** Randomized base delay per action + exponential backoff on `backoff` signal. Configurable per-site via `PacingProfile`.
6. **DeletionLog.** Append-only to `chrome.storage.local` keyed by `runId`. Read-back for resume.
7. **Bluesky adapter (panel-side).** `enumerate`/`deleteItem` for posts, replies, likes. URL discovery during enumeration (URLs are not assumed — they're found as part of the process). Date filter for posts + replies; disabled for likes.
8. **RunController.** Start (pin active tab id), Stop (clean abort between items), resume-from-log on Start if a prior `runId` is incomplete.
9. **Panel UI.** Category checkboxes, date filter (auto-disables when only Likes is checked), Delete / Stop buttons, progress bar, live log view. Must work at narrow side-panel widths (~320px).
10. **LlmClient.** Configurable base URL + model. Two jobs: `healSelector({snapshot, intent}) -> selector` (validated against live DOM before caching), `triageState({pageText}) -> 'dismiss'|'backoff'|'pause_for_human'|'abort'`. Graceful absence (no endpoint → pause-and-notify).
11. **Validation gate** (replaces automated tests — DOM automation is hard to unit-test):
    - Full run: all 3 categories, date-filtered, on a test account.
    - Force-break a selector mid-run → confirm LLM heals it (or pause-and-notify if no LLM).
    - Kill run mid-way → restart → confirm resume skips deleted items.
    - Close pinned tab mid-run → confirm pause-and-notify.
    - Likes-only run with date filter → confirm UI disables date filter.

**Done when** all 5 validation-gate items pass on a test Bluesky account.

## Phase 2 — X

- Port the adapter; expect the real anti-bot friction here.
- Likes are an *unlike* action, not a delete — adapter handles the semantic difference.
- Reposts/quote-posts enumeration quirks; tighter pacing profile.
- Harden triage paths: rate-limit banners, "something went wrong" toasts, re-login walls.

**Done when:** a sustained multi-hour run on a real account completes without account flags, with backoff observed under rate limiting.

## Phase 3 — Threads — implemented, pending live verification

Shipped (built ahead of Phase 2, since Threads' DOM was inspectable): site registry
(`src/adapters/index.ts`), `src/adapters/threads.ts`, `src/selectors/threads.json`,
`entrypoints/threads.content.ts`, `clickByText` primitive, `DEFAULT_THREADS_PACING`.

Threads specifics that shaped the port:

- **No `data-testid` anywhere** and obfuscated per-build class names, so selectors use only
  `role` / `aria-label` / `data-pressable-container`, and the delete + undo-repost menu items
  are reached by **visible text** (`clickByText`) because nothing else identifies them.
- **Categories are real routes** (`/@handle`, `/@handle/replies`, `/@handle/reposts`) — the
  adapter navigates instead of clicking tabs.
- **No Likes** — Threads doesn't list liked posts, so the category is absent from the site's
  registration and hidden in the panel.
- **Deleted posts stay in the DOM until reload**, so a successful click sequence is the only
  success signal; the skip-set absorbs the re-encounters.
- Slower pacing (2.5–6s per action, 10s backoff base, 10min cap) for Meta's automation defences.

Verified on a live account: item root, permalink, `time[datetime]`, `More` menu, the `Delete`
menu item, the `Delete post?` confirm dialog (two text-only buttons), and one real deletion.

**Verified on the live account** by performing one real deletion of each type:

- Post delete, reply delete: `More` → `[role="menuitem"]` "Delete" → confirm dialog "Delete".
- Undo-repost: the Repost control opens a menu of exactly **"Remove"** and "Quote", and Remove
  takes effect with **no confirmation dialog** — code that waited for one would hang on every repost.
- The confirm dialog's "Delete" and "Cancel" are both bare `[role="button"]` divs distinguishable
  only by text, so exact text matching is load-bearing, not a nicety.
- The `/replies` route **interleaves other authors' parent posts** with your own replies (4
  containers for 2 owned replies). Enumeration probes `a[href="/@<handle>"]` for ownership;
  without it a run opens strangers' posts, finds no Delete, and emits a stream of skips —
  which could then trip the all-skipped heuristic into "repairing" selectors that were fine.

**Still to verify:** `dismissControls` (triage's modal-close selector), a multi-hour sustained run
(backoff under Meta rate limiting), lazy-load scrolling to exhaustion on a large profile
(`ROUTE_SETTLE_MS` 2500 is a guess), and resume across a Threads run. Threads also has no known
not-found marker, so a bad route enumerates 0 items and surfaces as `suspicious` rather than a
clear error.

**Done when:** parity with Phase 2 criteria on Threads.

## Distribution milestone (alongside Phase 1)

- Public GitHub repo, release ZIPs of the built extension.
- Illustrated README walkthrough for non-technical users (load-unpacked flow).
- **Release workflow:** GitHub Action on `v*` tag — `npm ci && wxt zip` (WXT produces the release zip directly from `.output/`). Release notes auto-generated from commit range. Lets selector fixes ship the hour a site redesign breaks them, with no store review gate.

## Explicitly out of v1

- **Content-based delete/keep decisions via LLM** ("delete anything political") — a later phase; slower, token-heavy, and risks wrong deletions.
- **Rich filters** (keyword, engagement thresholds).
- **Dry-run / preview mode** — deliberately excluded by product decision (one-click start, Stop to halt).
- **Firefox port** — WXT keeps the door open; AMO unlisted signing is the path if it happens.
- **Full agentic driving** (LLM decides every click) — rejected as the base loop; deterministic-first stands.
