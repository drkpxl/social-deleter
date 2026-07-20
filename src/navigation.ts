/**
 * Tab navigation helper. Categories live on different profile routes, so the
 * adapter must drive the tab there before enumerating.
 *
 * Navigation destroys the content script; src/rpc.ts re-injects on demand, so
 * callers need no special handling beyond awaiting this.
 */
import { browser } from 'wxt/browser';

const LOAD_TIMEOUT_MS = 15_000;
const POLL_STEP_MS = 200;
/** Bluesky is an SPA: `status === 'complete'` fires before the feed renders. */
const SETTLE_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function navigateTab(tabId: number, url: string): Promise<void> {
  const current = await browser.tabs.get(tabId);
  if (current.url && normalize(current.url) === normalize(url)) return;

  await browser.tabs.update(tabId, { url });

  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let complete = false;
  while (Date.now() < deadline) {
    await sleep(POLL_STEP_MS);
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') {
      complete = true;
      break;
    }
  }
  if (!complete) {
    throw new Error(`Navigation to ${url} did not finish loading within ${LOAD_TIMEOUT_MS}ms`);
  }

  await sleep(SETTLE_MS);
}
