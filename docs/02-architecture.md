# Architecture

## Stack

- **TypeScript + [WXT](https://wxt.dev/)** — Vite-based extension framework: auto-generated MV3 manifest, HMR dev mode, cross-browser build output for a possible later Firefox port.
- **Node 22** toolchain. `wxt build` outputs the unpacked folder users load in Chrome.
- No backend, no accounts, no telemetry. Everything runs locally.

## Component layout

```
┌─────────────────────────────────────────────────────┐
│ Side panel (extension page)                          │
│  • owns the long-running deletion loop (orchestrator)│
│  • UI: category checkboxes (posts/replies/likes),    │
│    date filter, Delete / Stop, progress + log view   │
└───────────────┬─────────────────────────────────────┘
                │ chrome.runtime messaging
┌───────────────┴──────────────┐   ┌───────────────────┐
│ Content script (per site)    │   │ Service worker    │
│  primitive commands only:    │   │  thin glue:       │
│  scroll, enumerate, openMenu,│   │  messaging relay, │
│  clickDelete, readState      │   │  panel lifecycle  │
└──────────────────────────────┘   └───────────────────┘
```

The orchestration loop lives in the **side panel**, not the MV3 service worker — panel pages stay alive while open, sidestepping the 30-second service-worker idle kill entirely. The service worker stays thin (message relay only).

## Site adapter pattern

One adapter per platform (Bluesky → X → Threads), all implementing a common interface:

```ts
interface SiteAdapter {
  site: 'bluesky' | 'x' | 'threads';
  categories: Category[];                       // posts | replies | likes
  enumerateItems(cat: Category): AsyncIterable<Item>; // scroll + collect, with timestamps
  deleteItem(item: Item): Promise<DeleteResult>;
  selectors: SelectorMap;                       // versioned, LLM-repairable
  pacing: PacingProfile;                        // per-site delay/backoff tuning
}
```

Selectors live in a **versioned selector map** — plain data, not code — so they can be hot-patched at runtime when the LLM repairs one, and shipped as fast follow-up releases.

## LLM integration (fallback-only, two jobs)

OpenAI-compatible client with a configurable base URL:

- Ollama: `http://localhost:11434/v1` (requires `OLLAMA_ORIGINS` to include the extension origin)
- LM Studio: `http://localhost:1234/v1` (enable CORS in server settings)

`host_permissions` covers localhost. The LLM is **never in the main loop**. It is invoked in exactly two situations:

1. **Selector self-healing.** A cached selector stops matching (site redesign). The LLM receives a trimmed DOM snapshot around the expected element and proposes a replacement CSS selector. The proposal is validated against the live DOM before being cached into the selector map; on failure, retry with more context, then pause-and-notify.
2. **Unexpected-state triage.** The page shows something unplanned (modal, rate-limit banner, captcha, logged-out state). The LLM receives trimmed page text/DOM and must answer with one of a **fixed enum** of recovery actions: `dismiss`, `backoff`, `pause_for_human`, `abort`. No free-form actions.

Both jobs run comfortably on 7–14B local models. If no LLM endpoint is configured or reachable, the extension still works — it just pauses and notifies the human instead of self-healing.

## Pacing and stealth

- Randomized human-like delays between actions (per-site `PacingProfile`).
- Exponential backoff on any rate-limit signal.
- Captcha or logged-out state → `pause_for_human`, never automated.

## Control flow and safety posture

- **Start**: user selects categories + date filter (all / older-than / range) and hits **Delete**. Deletion begins immediately — no confirmation dialog, no dry-run. This is a deliberate product decision: one click starts, one click stops.
- **Stop**: aborts cleanly between items.
- **Deletion log** (the safety net): an append-only local JSON log — text snippet, URL, timestamp per deleted item — written via `chrome.storage` as the run progresses. Zero friction for the user, gives a record of what's gone, and doubles as the **resume checkpoint** after a stop or crash.
