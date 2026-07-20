/**
 * Threads (threads.com) site adapter — panel-side, same shape as the Bluesky
 * adapter: a panel-side `enumerate` generator plus a `deleteItem` that issues
 * DOM primitives over RPC.
 *
 * Two things differ from Bluesky and drive the whole file:
 *  - Categories are REAL ROUTES (/@handle, /@handle/replies, /@handle/reposts),
 *    so navigation replaces Bluesky's client-side tab clicking.
 *  - Threads ships no data-testid anywhere and its class names are obfuscated
 *    per build, so the menu items can only be found by their visible TEXT —
 *    hence clickByText rather than clickDelete.
 */
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import type {
  Category,
  DateFilter,
  DeleteResult,
  Item,
  NodeInfo,
  PrimitiveResult,
  Site,
  SiteAdapter,
} from '../types';
import { createRpcClient } from '../rpc';
import { selectorMap, SelectorMissingError } from '../selector-map';
import { signatureOf } from '../deletion-log';
import { navigateTab } from '../navigation';
import { DEFAULT_THREADS_PACING } from '../pacing';
import { messageOf } from '../errors';

const SITE: Site = 'threads';

/** Built content-script bundle for this site (injected on demand by the RPC client). */
export const THREADS_CONTENT_SCRIPT: ScriptPublicPath = '/content-scripts/threads.js';

/** www.threads.com is current; threads.net is the legacy domain and still resolves. */
export const THREADS_HOSTS = ['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'];

/** Threads lists posts, replies and reposts on the profile — liked posts are not listed anywhere. */
export const THREADS_CATEGORIES: Category[] = ['posts', 'replies', 'reposts'];

export const TIMESTAMP_SELECTOR_KEY = 'itemTimestamp';

/**
 * Every category uses the same item root; the ROUTE is what decides which items
 * are in the DOM. The keys stay distinct so a heal can diverge per category if a
 * future redesign splits them.
 */
export const ITEM_SELECTOR_KEY: Record<Category, string> = {
  posts: 'postItem',
  replies: 'replyItem',
  reposts: 'repostItem',
  // Unreachable: `likes` is not in THREADS_CATEGORIES, but the type is total.
  likes: 'postItem',
};

export const DELETE_CONTROL_SELECTOR_KEY: Record<Category, string> = {
  posts: 'menuButton',
  replies: 'menuButton',
  reposts: 'repostButton',
  likes: 'menuButton',
};

/** Threads renders a real <time datetime> on every listed item, reposts included. */
export const SUPPORTS_DATE_FILTER: Record<Category, boolean> = {
  posts: true,
  replies: true,
  reposts: true,
  likes: false,
};

/** Profile sub-route holding each category, appended to /@handle. */
const CATEGORY_PATH: Record<Category, string> = {
  posts: '',
  replies: '/replies',
  reposts: '/reposts',
  likes: '',
};

/** Labels Threads may use for undoing a repost — the menu item carries only text. */
const UNDO_REPOST_TEXTS = ['Remove', 'Unrepost'];

const MAX_NO_PROGRESS = 3;

/** Threads lazy-loads hard; give the new route's feed time to render before querying. */
const ROUTE_SETTLE_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract `<handle>` from a threads.com `/@<handle>/...` URL (the `@` is stripped). */
export function handleFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!THREADS_HOSTS.includes(parsed.hostname)) return undefined;
  const first = parsed.pathname.split('/').filter(Boolean)[0];
  if (!first || !first.startsWith('@') || first.length < 2) return undefined;
  return first.slice(1);
}

export function routeFor(handle: string, category: Category): string {
  return `https://www.threads.com/@${handle}${CATEGORY_PATH[category]}`;
}

/** Identical contract to the Bluesky adapter's: structured `code` in, DeleteResult out. */
function toFailure(result: PrimitiveResult, keyByArg: Record<string, string>): DeleteResult {
  const reason = result.reason ?? 'primitive failed';
  if (result.code === 'item-missing') return { status: 'skipped', reason };
  const selectorKey = result.failedArg ? keyByArg[result.failedArg] : undefined;
  const failure: DeleteResult = { status: 'failed', reason };
  if (selectorKey) failure.selectorKey = selectorKey;
  if (result.code) failure.code = result.code;
  return failure;
}

function rethrowIfHealable(err: unknown): void {
  if (err instanceof SelectorMissingError) throw err;
}

function toItem(category: Category, node: NodeInfo): Item {
  const item: Item = {
    site: SITE,
    category,
    elementKey: node.elementKey,
    textSnippet: node.textSnippet,
  };
  if (node.url) item.url = node.url;
  if (node.timestamp) item.timestamp = new Date(node.timestamp);
  return item;
}

/** Items with no readable date never match a date-bounded filter — we never delete what we can't date. */
export function matchesDateFilter(timestamp: Date | undefined, filter: DateFilter): boolean {
  if (filter.mode === 'all') return true;
  if (!timestamp) return false;
  const t = timestamp.getTime();
  if (filter.mode === 'olderThan') return t < filter.date.getTime();
  return t >= filter.from.getTime() && t <= filter.to.getTime();
}

export function createThreadsAdapter(tabId: number): SiteAdapter {
  const rpc = createRpcClient(tabId, THREADS_CONTENT_SCRIPT);
  const resolve = (key: string): Promise<string> => selectorMap.get(SITE, key);

  async function currentHandle(): Promise<string> {
    const state = await rpc.readState();
    const handle = handleFromUrl(state.url);
    if (!handle) {
      throw new Error(
        `Open your Threads profile page (threads.com/@<handle>) in this tab before deleting — current URL: ${state.url}`,
      );
    }
    return handle;
  }

  async function* enumerate(category: Category, dateFilter: DateFilter): AsyncIterable<Item> {
    // Threads categories are real routes, so navigation IS the category switch —
    // there is no tab control to click and no client-side state to wait on
    // beyond the feed render. Threads has no known "not found" marker, so no
    // page-found assert is made here; an unknown route simply enumerates 0 items
    // and the controller's `suspicious` path reports it.
    const handle = await currentHandle();
    await navigateTab(tabId, routeFor(handle, category));
    await sleep(ROUTE_SETTLE_MS);

    const selector = await resolve(ITEM_SELECTOR_KEY[category]);
    const timestampSelector = await resolve(TIMESTAMP_SELECTOR_KEY);
    // VERIFIED on a live account: the /replies route interleaves the PARENT
    // posts (authored by others) with the user's own replies — 4 containers for
    // 2 owned replies. Every container that is ours links to our own profile,
    // so that link is the ownership test. Without it the run opens other
    // people's posts, finds no Delete, and reports a stream of skips.
    const ownedProbe = `a[href="/@${handle}"]`;
    const applyDate = SUPPORTS_DATE_FILTER[category];
    // Dedupe by content signature: queryItems restamps data-sd-key per call, so
    // elementKey is not stable across rounds; snippet|url is.
    const yielded = new Set<string>();
    let noProgress = 0;
    let reachedEnd = false;

    while (true) {
      const nodes = await rpc.queryItems({
        selector,
        timestampSelector,
        probes: { owned: ownedProbe },
      });
      let newThisRound = 0;

      for (const node of nodes) {
        const item = toItem(category, node);
        const signature = signatureOf(item);
        if (yielded.has(signature)) continue;
        yielded.add(signature);
        newThisRound++;
        // Count it as seen (so scrolling still makes progress) but never yield
        // someone else's post — only our own content is ours to delete.
        if (node.probes?.owned === false) continue;
        if (applyDate && !matchesDateFilter(item.timestamp, dateFilter)) continue;
        yield item;
      }

      if (newThisRound === 0) {
        noProgress++;
        if (reachedEnd || noProgress >= MAX_NO_PROGRESS) break;
      } else {
        noProgress = 0;
      }

      const scrolled = await rpc.scroll({ direction: 'down' });
      reachedEnd = scrolled.atEnd;
    }
  }

  async function deleteViaMenu(item: Item): Promise<DeleteResult> {
    const menuButton = await resolve('menuButton');
    try {
      const opened = await rpc.openMenu({
        itemSelector: item.elementKey,
        menuButtonSelector: menuButton,
      });
      // `itemSelector` is this item's stamped key, not a selector-map entry, so
      // it stays unmapped — a miss there is the item vanishing, not a bad selector.
      if (!opened.ok) return toFailure(opened, { menuButtonSelector: 'menuButton' });

      // The menu items have no testid and no aria-label; "Delete" is the only handle.
      const menuItemSelector = await resolve('deleteMenuItem');
      const clicked = await rpc.clickByText({ selector: menuItemSelector, text: 'Delete' });
      if (!clicked.ok) return toFailure(clicked, { selector: 'deleteMenuItem' });

      // The confirmation dialog ("Delete post? … you won't be able to restore
      // it.") holds exactly two [role="button"] DIVs — Delete and Cancel — that
      // are indistinguishable except by their text, so this MUST go through
      // clickByText's exact match. Picking "the first match" would be relying on
      // document order to avoid clicking Cancel.
      const confirmSelector = await resolve('deleteConfirm');
      const confirmed = await rpc.clickByText({ selector: confirmSelector, text: 'Delete' });
      if (!confirmed.ok) return toFailure(confirmed, { selector: 'deleteConfirm' });

      // VERIFIED on a live account: a deleted Threads post stays in the DOM until
      // the page reloads (the item count is unchanged right after a successful
      // delete). So a successful click sequence IS the success signal — never
      // verify that the node vanished, and expect to re-encounter the item while
      // enumeration continues; the content-signature skip-set absorbs that.
      return { status: 'deleted' };
    } catch (err) {
      rethrowIfHealable(err);
      return { status: 'failed', reason: messageOf(err) };
    }
  }

  async function undoRepost(item: Item): Promise<DeleteResult> {
    const repostButton = await resolve('repostButton');
    const undoMenuItem = await resolve('undoRepostMenuItem');
    try {
      // Scope the button to this item's stamped root; the menu renders in a portal.
      const opened = await rpc.click({ selector: `${item.elementKey} ${repostButton}` });
      if (!opened.ok) return toFailure(opened, { selector: 'repostButton' });

      // VERIFIED on a live account: the Repost control opens a menu of exactly
      // "Remove" and "Quote", and Remove takes effect with NO confirmation
      // dialog (unlike Delete) — so never wait for one here. "Unrepost" is kept
      // as a fallback wording; a miss reports the texts that WERE in the menu.
      let last: PrimitiveResult = { ok: false, reason: 'no undo label tried' };
      for (const text of UNDO_REPOST_TEXTS) {
        last = await rpc.clickByText({ selector: undoMenuItem, text });
        if (last.ok) return { status: 'deleted' };
      }
      return toFailure(last, { selector: 'undoRepostMenuItem' });
    } catch (err) {
      rethrowIfHealable(err);
      return { status: 'failed', reason: messageOf(err) };
    }
  }

  async function deleteItem(item: Item): Promise<DeleteResult> {
    if (item.category === 'likes') {
      return { status: 'failed', reason: 'Threads does not expose liked posts — nothing to unlike' };
    }
    if (item.category === 'reposts') return undoRepost(item);
    return deleteViaMenu(item);
  }

  return {
    site: SITE,
    categories: THREADS_CATEGORIES,
    supportsDateFilter: SUPPORTS_DATE_FILTER,
    itemSelectorKey: ITEM_SELECTOR_KEY,
    deleteControlSelectorKey: DELETE_CONTROL_SELECTOR_KEY,
    timestampSelectorKey: TIMESTAMP_SELECTOR_KEY,
    pacing: DEFAULT_THREADS_PACING,
    enumerate,
    deleteItem,
  };
}
