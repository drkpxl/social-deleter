/**
 * Tab navigation helper. Categories live on different profile routes, so the
 * adapter must drive the tab there before enumerating.
 *
 * Navigation destroys the content script; src/rpc.ts re-injects on demand, so
 * callers need no special handling beyond awaiting this.
 */
import { browser } from 'wxt/browser';
import { createRpcClient } from './rpc';

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

/** Bluesky renders a 200-page for unknown routes; without this it enumerates as "0 items". */
const NOT_FOUND_SELECTOR = '[data-testid="notFoundView"]';

/**
 * Throw if the tab is showing Bluesky's not-found view. Call after navigation:
 * an error page has no feed, so enumerating it looks like an empty category.
 */
export async function assertPageFound(tabId: number): Promise<void> {
  const rpc = createRpcClient(tabId);
  const hits = await rpc.queryItems({ selector: NOT_FOUND_SELECTOR });
  if (hits.length === 0) return;
  const state = await rpc.readState();
  throw new Error(`Bluesky shows a "not found" page at ${state.url} — nothing can be enumerated here`);
}
