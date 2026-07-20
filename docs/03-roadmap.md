# Roadmap

## Phase 1 — Bluesky (the training ground)

Build the entire skeleton against the friendliest target. Tasks are ordered for incremental verification:

1. **Scaffold.** `npm create wxt@latest`, TypeScript strict, side panel entry, content script entry, service worker. `.gitignore`, GitHub Actions release workflow (tag → `wxt build` → zip → GH release).
2. **Messaging RPC.** Tiny typed `chrome.runtime` port wrapper: `call(tabId, method, args) -> Promise<result>`. One file, no framework.
3. **DomPrimitives (Bluesky).** Content script, stateless: `scroll({direction, amount})`, `enumerate({selector}) -> NodeInfo[]`, `openMenu({itemSelector})`, `clickDelete({menuSelector})`, `readState() -> {url, scrollY, modalPresent, bannerText?}`. No business logic.
4. **SelectorMap + shipped Bluesky selectors.** `src/selectors/bluesky.json` v1. Resolution (override → shipped → LLM-heal → pause) + override store in `chrome.storage.local`. Schema-version bump on update discards overrides; logged.
5. **PacingEngine.** Randomized base delay per action + exponential backoff on `backoff` signal. Configurable per-site via `PacingProfile`.
6. **DeletionLog.** Append-only to `chrome.storage.local` keyed by `runId`. Read-back for resume.
7. **Bluesky adapter (panel-side).** `enumerate`/`deleteItem` for posts, replies, likes. URL discovery during enumeration (URLs are not assumed — they're found as part of the process). Date filter for posts + replies; disabled for likes.
8. **RunController.** Start (pin active tab id), Stop (clean abort between items), resume-from-log on Start if a prior `runId` is incomplete.
9. **Panel UI.** Category checkboxes, date filter (auto-disables when only Likes is checked), Delete / Stop buttons, progress bar, live log view. Mobile-responsive (reviewed on mobile first).
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

## Phase 3 — Threads

- Adapter port; expect Meta fingerprinting and aggressive lazy-loading DOM.
- Reuse everything from Phases 1–2; this phase should be mostly selector work.

**Done when:** parity with Phase 2 criteria on Threads.

## Distribution milestone (alongside Phase 1)

- Public GitHub repo, release ZIPs of the built extension.
- Illustrated README walkthrough for non-technical users (load-unpacked flow).
- **Release workflow:** GitHub Action on `v*` tag — `npm ci && wxt build && zip -r social-deleter-${tag}.zip .output/chrome-mv3`. Release notes auto-generated from commit range. Lets selector fixes ship the hour a site redesign breaks them, with no store review gate.

## Explicitly out of v1

- **Content-based delete/keep decisions via LLM** ("delete anything political") — a later phase; slower, token-heavy, and risks wrong deletions.
- **Rich filters** (keyword, engagement thresholds).
- **Dry-run / preview mode** — deliberately excluded by product decision (one-click start, Stop to halt).
- **Firefox port** — WXT keeps the door open; AMO unlisted signing is the path if it happens.
- **Full agentic driving** (LLM decides every click) — rejected as the base loop; deterministic-first stands.
