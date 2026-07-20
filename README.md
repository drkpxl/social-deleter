# Social Deleter

A browser extension that deletes **your own** posts, replies, reposts, and likes in bulk — from your own logged-in browser.

| Platform | Posts | Replies | Reposts | Likes |
|---|:--:|:--:|:--:|:--:|
| **Bluesky** | ✅ | ✅ | ✅ | ✅ |
| **Threads** | ✅ | ✅ | ✅ | — ¹ |
| X / Twitter | planned | planned | planned | planned |

¹ Threads doesn't list your liked posts anywhere, so they can't be deleted from the web app.

It runs entirely on your machine. There is no server, no account, no data collection. An optional local AI model (Ollama or LM Studio) can help it recover when a site changes its layout, but the extension works without it.

> ⚠️ **Deletion is permanent.** There is no undo, and there is no confirmation prompt — pressing Delete starts immediately. Download your data archive first if you might want it (Bluesky: Settings → Export my data; Threads: Settings → Account → Download your information). Social Deleter keeps a local log of everything it removed, but a log is not a backup — it cannot restore anything.

---

## Install (for everyone — no coding needed)

Works in **Chrome, Vivaldi, Brave, and Edge** — they all share the same engine, so one download covers them. These stores don't list automation tools like this, so you install it directly. It takes about two minutes.

1. **Download it.** On the [Releases page](https://github.com/drkpxl/social-deleter/releases), click the latest `social-deleter-*.zip` under **Assets**.
2. **Unzip it.** Double-click the downloaded file. You'll get a folder — move it somewhere you won't delete by accident (e.g. your Documents folder). Your browser loads it from this folder every time, so it needs to stay put.
3. **Open the extensions page.** Type the address for your browser into the address bar:
   | Browser | Address |
   |---|---|
   | Chrome | `chrome://extensions` |
   | Vivaldi | `vivaldi://extensions` |
   | Brave | `brave://extensions` |
   | Edge | `edge://extensions` |
4. **Turn on Developer mode.** It's a toggle in the **top-right corner** (in Edge, it's on the **left** sidebar).
5. **Load it.** Click **Load unpacked**, then select the folder you unzipped in step 2.
6. **Pin it.** Click the puzzle-piece icon in the toolbar, then the pin next to Social Deleter.

Done. Click the Social Deleter icon any time to open its panel.

### Updating

When a new version is released (sites change often, so this happens), download the new ZIP, unzip it **over the same folder** (replace when asked), then click the refresh icon on Social Deleter's card on your browser's extensions page.

---

## How to use it

1. Log in as you normally would and open **your own profile page**:
   - Bluesky → `bsky.app/profile/<your-handle>`
   - Threads → `threads.com/@<your-handle>`
2. Click the Social Deleter toolbar icon to open the side panel. It should say **Ready on Bluesky** / **Ready on Threads**.
3. Tick the categories you want to clear. Only the ones that platform supports are shown.
4. Optionally set a **date filter** (e.g. only delete posts older than a date). Bluesky likes carry no date, so the filter disables itself if likes are all you've selected.
5. Click **Delete**. It starts immediately — there's no confirmation step — and works down your profile at a human-like pace.
6. Watch the live log. Click **Stop** any time — it halts cleanly between items, and you can resume later where it left off.

**Leave that tab open and in the foreground while it runs.** The extension drives the page you're looking at; switching the tab away or closing it pauses the run (resumable).

Deletion is deliberately unhurried — seconds between actions, slower still on Threads. A few thousand items takes hours, not minutes. That pacing is what keeps a bulk purge from looking like a bot to the platform.

### Optional: local AI fallback

If a site redesign breaks the extension mid-run, a local AI model can propose a fix so the run continues instead of stopping. This is entirely optional.

- Install [Ollama](https://ollama.com) (endpoint `http://localhost:11434/v1`) or [LM Studio](https://lmstudio.ai) (endpoint `http://localhost:1234/v1`) and load a small model (a 7B–14B model is plenty).
- In Social Deleter's **AI settings**, enter the endpoint and model name, then click **Test**.

**Ollama users — this step is required, and skipping it fails silently.** Ollama refuses requests from browser extensions until you allow them, and the refusal looks exactly like the AI doing nothing at all. On macOS:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
# then fully quit Ollama (menu bar → Quit) and reopen it
```

On Linux, set `OLLAMA_ORIGINS="chrome-extension://*"` in the environment Ollama starts from (e.g. `systemctl edit ollama`). **LM Studio users:** enable CORS in its server settings.

Then click **Test** in the extension's AI settings. It sends a real request, so "Ready ✓" means repairs will actually work — if it reports a 403, the step above hasn't taken effect yet.

Without a configured model, the extension simply pauses and notifies you instead of self-healing.

---

## For developers

Built with [WXT](https://wxt.dev/) + TypeScript. Requires Node 22.

```bash
npm install
npm run dev          # launches Chrome with the extension in dev mode (HMR)
npm run dev:vivaldi  # same, in Vivaldi (also: dev:chrome, dev:edge)
npm run compile      # typecheck (tsc --noEmit)
npm run build        # production build → .output/chrome-mv3
npm run zip          # packaged release zip
```

Architecture, design decisions, and the roadmap live in [`docs/`](./docs). The short version: the side panel is the brain (owns the deletion loop, pacing, logging, resume), and a stateless content script is a remote DOM arm driven over typed RPC. Per-site behaviour lives in `src/adapters/` behind a registry (`src/adapters/index.ts`); selectors are versioned JSON that a local LLM can hot-patch when a site changes.

The two supported sites deliberately share nothing but that interface, which is a useful sanity check on it:

| | Bluesky | Threads |
|---|---|---|
| Stable hooks | `data-testid` everywhere | **none** — obfuscated per-build classes; selectors use `role`/`aria-label` only |
| Switching category | client-side tab click (URL never changes) | real routes (`/@you/replies`) |
| Timestamps | no `<time>`; prose in `aria-label`/`data-tooltip` | real `time[datetime]` |
| After a delete | node disappears | node lingers until reload |

**Panel diagnostics.** The panel has a *Diagnostics → Copy selector report* button that dumps what every shipped selector matches on the current page, plus a real DOM sample. That report is the fastest way to fix a broken selector — and the right thing to paste into a bug report.

## Scope & responsibility

This tool automates actions **you are already allowed to take** on your own account, in your own browser session. It deletes only your own content. It does not scrape others' data, mass-target accounts, or evade authentication. Automated bulk actions may still be against a platform's Terms of Service — that's your call to make for your account. Use it on accounts you own.
