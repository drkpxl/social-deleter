# Architecture

## Stack

- **TypeScript + [WXT](https://wxt.dev/)** — Vite-based extension framework: auto-generated MV3 manifest, HMR dev mode, cross-browser build output for a possible later Firefox port.
- **Node 22** toolchain. `wxt build` outputs the unpacked folder users load in Chrome.
- No backend, no accounts, no telemetry. Everything runs locally.

## Component layout

```
┌─────────────────────────────────────────────────────┐
│ Side panel (extension page) — long-lived orchestrator│
│  • AdapterRegistry   (one SiteAdapter impl per site) │
│  • PacingEngine      (randomized delays + backoff)   │
│  • SelectorMap       (shipped JSON + storage overrides)
│  • LlmClient         (OpenAI-compatible, optional)    │
│  • DeletionLog       (append-only, chrome.storage)   │
│  • RunController     (start/stop, tab pin, resume)    │
│  • UI: category checkboxes, date filter,             │
│    Delete / Stop, progress + log view                │
└───────────────┬─────────────────────────────────────┘
                │ chrome.runtime messaging (typed RPC over port)
┌───────────────┴──────────────┐   ┌───────────────────┐
│ Content script (per site)    │   │ Service worker    │
│  STATELESS DOM primitives:    │   │  thin glue:       │
│  scroll, queryItems, openMenu,│   │  messaging relay, │
│  clickDelete, readState       │   │  panel lifecycle  │
└──────────────────────────────┘   └───────────────────┘
```

The orchestration loop lives in the **side panel**, not the MV3 service worker — panel pages stay alive while open, sidestepping the 30-second service-worker idle kill entirely. The service worker stays thin (message relay only).

### Why the adapter lives in the panel, not the content script

The content script is **stateless and dumb** by design: it only executes DOM primitives (`scroll`, `queryItems`, `openMenu`, `clickDelete`, `readState`) and returns results. (`queryItems` is deliberately not named `enumerate` — that name belongs to the adapter method in the panel.) All adapter logic — the iteration cursor, selector cache, pacing timers, LLM-repair state, and the deletion log — lives in the panel.

Why not put the adapter in the content script (the "smart content script" alternative):

- **Content scripts die on tab navigation/reload.** Bluesky/X/Threads are SPAs that still hard-reload on certain actions. If the adapter owned the iteration cursor and selector overrides, a mid-run reload would lose all of it — and a mid-run reload is exactly when state matters most.
- **Panel state survives tab reloads.** The async generator driving `enumerate` is a closure in the panel; the content script just re-injects on navigation and keeps answering primitives. The loop picks up where it left off.
- **Round-trip cost is negligible.** Every DOM touch is a `chrome.runtime` round-trip (sub-millisecond), dwarfed by the human-paced delays between actions.

This matches the diagram above: the panel is the brain, the content script is a remote DOM arm.

## Site adapter pattern

One adapter per platform (Bluesky → X → Threads), all implementing a common interface. **The adapter implementation lives in the panel** (see "Why the adapter lives in the panel" above); it drives a stateless content script via RPC.

```ts
interface SiteAdapter {
  site: 'bluesky' | 'x' | 'threads';
  categories: Category[];                          // posts | replies | likes
  supportsDateFilter: Record<Category, boolean>;   // likes = false on all sites
  itemSelectorKey: Record<Category, string>;       // selector-map key the controller heals when a category enumerates 0 items
  deleteControlSelectorKey: Record<Category, string>; // ...and when items enumerate but none are deletable
  enumerate(cat: Category, dateFilter: DateFilter): AsyncIterable<Item>; // panel-side async gen
  deleteItem(item: Item): Promise<DeleteResult>;   // issues DOM primitives over RPC
  selectors: SelectorMap;                           // versioned, LLM-repairable
  pacing: PacingProfile;                            // per-site delay/backoff tuning
}
```

### Site registry — the wiring seam

`src/adapters/index.ts` holds one `SiteRegistration` row per site: `site`, matching `hosts`,
a display `label`, the built `contentScript` bundle, the adapter `factory`, the `categories`
that site actually offers, and its `supportsDateFilter` map. Everything that used to be
scattered resolves from that row — the panel's supported-host check (`siteForUrl(tab.url)`),
the `RunConfig.site`, the `adapterFactory` handed to the RunController, the file the RPC
client injects on demand, and the shipped selector map diagnostics dumps. Adding a site is
one row plus its selectors JSON, adapter and content-script entrypoint.

### Sites do not share a navigation model

- **Bluesky:** profile tabs are **client-side state** — the URL never changes and
  `/replies`, `/likes` are 404s — so a category is reached by *clicking the tab* and
  waiting for the feed to re-render.
- **Threads:** profile categories are **real routes** (`/@handle`, `/@handle/replies`,
  `/@handle/reposts`), so the adapter navigates the tab; there is no tab control at all,
  and no known "not found" marker to assert against (an unknown route just enumerates 0
  items, which the controller's `suspicious` path reports).

The adapter owns this difference entirely; the primitives and the controller stay
site-agnostic. Threads also ships no `data-testid` and mangles its class names per build,
which is why the `clickByText` primitive exists: its delete menu item and its confirm-dialog
buttons are identifiable only by their visible text.

`enumerate` is a panel-side async generator that calls DOM primitives (`scroll`, `queryItems`) over the messaging port and yields `Item`s. Iteration state lives in the generator closure — it survives tab reloads because the generator is in the panel, not the content script.

### Date filter

- Modes: `all` | `olderThan: Date` | `range: [Date, Date]`.
- Per-category `supportsDateFilter`. Likes = `false` on all sites (likes views don't render timestamps; navigating into each liked post for its date is too slow and too suspicious for v1).
- UI: when only Likes is checked, the date filter controls disable themselves.

### Selector map — concrete shape and lifecycle

- **Shipped:** `src/selectors/<site>.json` with `{ schemaVersion, selectors: {...} }`. Each entry is either a bare selector string or `{ selector, intent }`, where `intent` is the plain-language description handed to the LLM when that selector needs repair — intents live beside their selector so a new key can't be added without one. Site-specific dismiss controls (modal/toast close buttons) live here too, under `dismissControls`.
- **Runtime overrides:** `chrome.storage.local[selectorOverrides:<site>]` = `{ schemaVersion, selectors }`.
- **Resolution order:** override (only if `schemaVersion` matches shipped) → shipped → LLM-heal → pause-and-notify.
- **On extension update:** if shipped `schemaVersion` bumps, overrides for that site are **discarded** (a schema bump signals a site redesign that invalidates old overrides). The discard is appended to the deletion log so the user sees it.
- **Hot-patch:** an LLM-healed selector is written to the override store and takes effect immediately for the running loop.

Selectors live in a **versioned selector map** — plain data, not code — so they can be hot-patched at runtime when the LLM repairs one, and shipped as fast follow-up releases.

## LLM integration (fallback-only, two jobs)

OpenAI-compatible client with a configurable base URL:

- Ollama: `http://localhost:11434/v1` (requires `OLLAMA_ORIGINS` to include the extension origin)
- LM Studio: `http://localhost:1234/v1` (enable CORS in server settings)

`host_permissions` covers localhost. The LLM is **never in the main loop**. It is invoked in exactly two situations:

1. **Selector self-healing.** A cached selector stops matching (site redesign). The LLM receives a trimmed DOM snapshot around the expected element and proposes a replacement CSS selector. The proposal is validated against the live DOM before being cached into the selector map; up to 3 proposals are tried per heal, each rejected one fed back to the model as "matched nothing", then pause-and-notify.

   Failures reach the healer **structurally, never by parsing prose**: DOM primitives return a `code` (`item-missing` | `trigger-missing` | `timeout` | `bad-selector`) plus the argument that failed; the adapter maps that to either a `skipped` result (`item-missing` — the item legitimately vanished) or `{ status: 'failed', selectorKey }` naming the exact selector-map key to heal. A failed tab switch throws `SelectorMissingError` carrying the tab's key. A `failed` result with no `selectorKey` is a genuine failure: triage once, then pause — the controller never guesses a key.

   Menu-only keys (`deleteMenuItem`, `deleteConfirm`, `undoRepostMenuItem`) render in a portal that exists only while the menu is open and is never inside the item element, so their heal snapshot anchors on the open overlay (`[role="menu"], [role="dialog"]`, degrading to the page body) instead of the item.

   The controller also heals `itemTimestamp`: under a date-bounded filter, items with no readable date are never deleted, so a category whose live items all lack a timestamp emits `suspicious` and heals that key before retrying the category once.
2. **Unexpected-state triage.** The page shows something unplanned (modal, rate-limit banner, captcha, logged-out state). The LLM receives trimmed page text/DOM and must answer with one of a **fixed enum** of recovery actions: `dismiss`, `backoff`, `pause_for_human`, `abort`. No free-form actions.

Both jobs run comfortably on 7–14B local models. If no LLM endpoint is configured or reachable, the extension still works — it just pauses and notifies the human instead of self-healing.

## Pacing and stealth

- Randomized human-like delays between actions (per-site `PacingProfile`).
- Exponential backoff on any rate-limit signal.
- Captcha or logged-out state → `pause_for_human`, never automated.

## Control flow and safety posture

- **Start**: user selects categories + date filter (all / older-than / range) and hits **Delete**. Deletion begins immediately — no confirmation dialog, no dry-run. This is a deliberate product decision: one click starts, one click stops.
- **Stop**: aborts cleanly between items.
- **Tab targeting:** the panel operates on whichever tab is **active when Delete is pressed**; that tab id is pinned for the run. If the pinned tab closes mid-run → pause-and-notify (the panel cannot drive a tab that no longer exists).
- **Deletion log** (the safety net): an append-only local JSON log — text snippet, URL (when discoverable), timestamp, `runId` per deleted item — written via `chrome.storage.local` as the run progresses. Zero friction for the user, gives a record of what's gone, and doubles as the **resume checkpoint** after a stop or crash.

### Resume semantics

Resume = **re-enumerate from a fresh page and skip already-deleted items.** No cursor, no matching by URL alone.

- Deletion log entry: `{ site, category, url?, textSnippet, timestamp, runId }`.
- On resume: load log entries for this `runId`, build a `Set` of normalized signatures `snippet|url` (url absent → `snippet` only). During enumeration, skip any item whose signature is in the set.
- **Reconciliation pass:** after enumeration catches up to where the log says it should be, do one extra scroll page; if new items appear, continue; if not, the category is complete.
- **Acceptable failure mode:** a handful of re-delete attempts on items already gone (harmless — the menu simply won't offer a delete, adapter treats as success-skip). Simpler and more robust than trying to be exact.
- **But never silently:** the controller tallies each category (`enumerated` / `deleted` / already-logged skips / adapter skips). A category that enumerates 0 items, or that enumerates items and deletes none while the adapter skipped them, emits a `suspicious` run event and — once per category per run, if an LLM is configured — heals `itemSelectorKey` / `deleteControlSelectorKey` and re-runs that category. A failed heal leaves the event as the record and moves on; an empty category never pauses or aborts the run.
