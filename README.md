# Social Deleter

A Chrome extension that deletes **your own** posts, replies, and likes on social platforms — in bulk, from your own logged-in browser. Bluesky is supported now; X and Threads are on the roadmap.

It runs entirely on your machine. There is no server, no account, no data collection. An optional local AI model (Ollama or LM Studio) can help it recover when a site changes its layout, but the extension works without it.

> ⚠️ **Deletion is permanent.** There is no undo. Before running, consider downloading your data archive from the platform first (Bluesky: Settings → Export my data). Social Deleter keeps a local log of what it deleted, but it cannot bring anything back.

---

## Install (for everyone — no coding needed)

Chrome doesn't list automation tools like this in its Web Store, so you install it directly. It takes about two minutes.

1. **Download it.** On the [Releases page](https://github.com/drkpxl/social-deleter/releases), click the latest `social-deleter-*.zip` under **Assets**.
2. **Unzip it.** Double-click the downloaded file. You'll get a folder — move it somewhere you won't delete by accident (e.g. your Documents folder). Chrome loads it from this folder every time, so it needs to stay put.
3. **Open the extensions page.** In Chrome, go to `chrome://extensions` (type it in the address bar).
4. **Turn on Developer mode.** Toggle the switch in the **top-right corner**.
5. **Load it.** Click **Load unpacked** (top-left), then select the folder you unzipped in step 2.
6. **Pin it.** Click the puzzle-piece icon in Chrome's toolbar, then the pin next to Social Deleter.

Done. Click the Social Deleter icon any time to open its panel.

### Updating

When a new version is released (sites change often, so this happens), download the new ZIP, unzip it **over the same folder** (replace when asked), then click the refresh icon on Social Deleter's card at `chrome://extensions`.

---

## How to use it

1. Log into **[bsky.app](https://bsky.app)** in Chrome as you normally would, and open your **profile page**.
2. Click the Social Deleter toolbar icon to open the side panel.
3. Tick the categories you want to clear — **Posts**, **Replies**, **Likes**.
4. Optionally set a **date filter** (e.g. only delete posts older than a date). Likes can't be date-filtered.
5. Click **Delete**. It starts immediately and works down your profile at a human-like pace.
6. Watch the live log. Click **Stop** any time — it halts cleanly, and you can resume later where it left off.

Keep the Bluesky tab open and in the foreground while it runs.

### Optional: local AI fallback

If a site redesign breaks the extension mid-run, a local AI model can propose a fix so the run continues instead of stopping. This is entirely optional.

- Install [Ollama](https://ollama.com) (endpoint `http://localhost:11434/v1`) or [LM Studio](https://lmstudio.ai) (endpoint `http://localhost:1234/v1`) and load a small model (a 7B–14B model is plenty).
- In Social Deleter's **AI settings**, enter the endpoint and model name, then click **Test** to confirm it's reachable.
- Ollama users: allow the extension to reach Ollama by setting the `OLLAMA_ORIGINS` environment variable to include the extension origin (`chrome-extension://*`). LM Studio users: enable CORS in its server settings.

Without a configured model, the extension simply pauses and notifies you instead of self-healing.

---

## For developers

Built with [WXT](https://wxt.dev/) + TypeScript. Requires Node 22.

```bash
npm install
npm run dev      # launches Chrome with the extension in dev mode (HMR)
npm run compile  # typecheck (tsc --noEmit)
npm run build    # production build → .output/chrome-mv3
npm run zip      # packaged release zip
```

Architecture, design decisions, and the roadmap live in [`docs/`](./docs). The short version: the side panel is the brain (owns the deletion loop, pacing, logging, resume), and a stateless content script is a remote DOM arm driven over typed RPC. Per-site behavior lives in `src/adapters/`; selectors are versioned JSON that a local LLM can hot-patch when a site changes.

## Scope & responsibility

This tool automates actions **you are already allowed to take** on your own account, in your own browser session. It deletes only your own content. It does not scrape others' data, mass-target accounts, or evade authentication. Automated bulk actions may still be against a platform's Terms of Service — that's your call to make for your account. Use it on accounts you own.
