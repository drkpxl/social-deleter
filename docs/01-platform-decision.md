# Platform Decision: Chrome Extension

**Decision: Chrome (Manifest V3) extension, distributed publicly on GitHub via load-unpacked install.**

## What this tool is

A browser extension that mass-deletes your own posts, replies, and likes on social platforms — Bluesky first, then X, then Threads. Deterministic DOM automation does the work; a local LLM (Ollama or LM Studio via an OpenAI-compatible endpoint) is called only as a fallback to repair broken selectors and triage unexpected page states.

## Why a browser extension at all

| Alternative | Why it was rejected |
|---|---|
| **Bluesky atproto API** (a Node CLI could delete everything cleanly) | Deliberately rejected. Bluesky serves as the low-stakes training ground for the exact DOM-automation machinery X and Threads require, where APIs are paywalled (X: $200+/mo for write access) or insufficient (Threads: no like/reply deletion). |
| **Playwright / CDP-driven browser** | X and Meta aggressively fingerprint automated browsers, and a deletion spree already looks suspicious. An extension runs inside the user's *real*, logged-in session — real cookies, real fingerprint, human browsing interleaved. Getting an account suspended mid-purge is the worst possible outcome. |
| **Web store distribution** | Google removes extensions when targeted platforms complain, and X/Meta have a litigious history against automation tools. Store review would also delay shipping selector fixes, which need to go out the hour a site redesign breaks them. |

## Chrome vs Firefox

| Axis | Chrome (MV3) | Firefox |
|---|---|---|
| Background lifetime | Service worker killed after ~30s idle — long deletion runs must live in a side panel / extension page instead | Persistent event pages; long-running loops are easy |
| Trusted input escape hatch | `chrome.debugger` can dispatch trusted events if a site ignores synthetic clicks | No equivalent |
| Sideload (personal) | Load unpacked in developer mode — painless, permanent | Stable Firefox refuses unsigned permanent installs; temporary add-ons vanish on restart |
| Self-distribution | Dev-mode load-unpacked only; `.crx` installs outside the store are blocked | **AMO unlisted signing**: signed `.xpi`, two-click permanent install on stock Firefox, no public listing |
| Store takedown risk | High if listed (platform complaints) | Lower, but nonzero |

Firefox's unlisted-signing channel is genuinely the cleaner *distribution* story, and this was weighed seriously. **Chrome won** because it is the browser actually in use here, the load-unpacked path is friction-free for the developer, and Chrome's dominant market share means instructions written once serve the most users. The MV3 service-worker limitation is designed around (see architecture doc), not fought.

## Distribution plan

- Public GitHub repository; releases are ZIPs of the built extension.
- README gets an illustrated, non-technical walkthrough: **download ZIP → unzip → `chrome://extensions` → enable Developer mode → Load unpacked**.
- Updates are manual re-downloads. Accepted tradeoff: no auto-update, but also no store review gate — selector fixes ship instantly.
- A Firefox port (via WXT's cross-browser build + AMO unlisted signing) is a candidate for later, not v1.
