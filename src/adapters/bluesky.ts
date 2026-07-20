/**
 * Bluesky (bsky.app) site adapter — panel-side. Drives the stateless content
 * script over RPC (see docs/02-architecture.md "Site adapter pattern").
 *
 * The adapter is the brain: `enumerate` is a panel-side async generator whose
 * iteration state (dedupe set, no-progress counter) lives in its closure, so it
 * survives content-script re-injection on SPA reloads. `deleteItem` issues DOM
 * primitives. The RunController (not this file) owns the delete-and-re-enumerate
 * loop and the resume skip-set; each `enumerate` call just starts fresh from the
 * current DOM.
 */
import type {
  Category,
  DateFilter,
  DeleteResult,
  Item,
  NodeInfo,
  Site,
  SiteAdapter,
} from '../types';
import { createRpcClient } from '../rpc';
import { selectorMap } from '../selector-map';
import { signatureOf } from '../deletion-log';
import { DEFAULT_BLUESKY_PACING } from '../pacing';

const SITE: Site = 'bluesky';

/** Item-root selector key per category (resolved via the selector map). */
const ITEM_SELECTOR_KEY: Record<Category, string> = {
  posts: 'postItem',
  replies: 'replyItem',
  likes: 'likeItem',
};

/** Consecutive no-new-item rounds tolerated before giving up (infinite-loop guard). */
const MAX_NO_PROGRESS = 3;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Does `timestamp` fall inside the filter? Items with no timestamp are treated
 * as NON-matching under a date-bounded mode (olderThan/range) — we never delete
 * what we can't date. Under `all`, everything matches. Only invoked for
 * categories where supportsDateFilter is true (never for likes).
 */
export function matchesDateFilter(timestamp: Date | undefined, filter: DateFilter): boolean {
  if (filter.mode === 'all') return true;
  if (!timestamp) return false;
  const t = timestamp.getTime();
  if (filter.mode === 'olderThan') return t < filter.date.getTime();
  return t >= filter.from.getTime() && t <= filter.to.getTime();
}

export function createBlueskyAdapter(tabId: number): SiteAdapter {
  const rpc = createRpcClient(tabId);
  const resolve = (key: string): Promise<string> => selectorMap.get(SITE, key);

  async function* enumerate(category: Category, dateFilter: DateFilter): AsyncIterable<Item> {
    const selector = await resolve(ITEM_SELECTOR_KEY[category]);
    const applyDate = category !== 'likes';
    // Dedupe by content signature, not elementKey: queryItems restamps
    // data-sd-key on every call (global counter), so a re-queried node returns a
    // different elementKey each round. The signature (snippet|url) is stable and
    // is the same identity the deletion log uses for resume skips.
    const yielded = new Set<string>();
    let noProgress = 0;
    let reachedEnd = false;

    while (true) {
      const nodes = await rpc.queryItems({ selector });
      let newThisRound = 0;

      for (const node of nodes) {
        const item = toItem(category, node);
        const signature = signatureOf(item);
        if (yielded.has(signature)) continue;
        yielded.add(signature);
        newThisRound++;
        if (applyDate && !matchesDateFilter(item.timestamp, dateFilter)) continue;
        yield item;
      }

      if (newThisRound === 0) {
        noProgress++;
        // Stop once the page is at its end AND a follow-up query found nothing
        // new, or if we've stalled regardless (deletes keep the DOM short so
        // scroll may never report atEnd — the counter still bails out).
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
      // Menu unavailable (button gone, item already deleted) → treat as skip:
      // docs "Acceptable failure mode" — a gone item simply won't offer delete.
      if (!opened.ok) return { status: 'skipped', reason: opened.reason ?? 'menu unavailable' };

      const menuItemSelector = await resolve('deleteMenuItem');
      const confirmSelector = await resolve('deleteConfirm');
      const clicked = await rpc.clickDelete({ menuItemSelector, confirmSelector });
      if (!clicked.ok) return { status: 'skipped', reason: clicked.reason ?? 'delete unavailable' };

      return { status: 'deleted' };
    } catch (err) {
      return { status: 'failed', reason: messageOf(err) };
    }
  }

  async function unlike(item: Item): Promise<DeleteResult> {
    const unlikeButton = await resolve('unlikeButton');
    // Likes are un-liked via the toggle, not a menu; scope the selector to this
    // item's stamped root so it can't match another item's like button.
    const scopedSelector = `${item.elementKey} ${unlikeButton}`;
    try {
      const clicked = await rpc.click({ selector: scopedSelector });
      if (!clicked.ok) return { status: 'skipped', reason: clicked.reason ?? 'unlike button unavailable' };
      return { status: 'deleted' };
    } catch (err) {
      return { status: 'failed', reason: messageOf(err) };
    }
  }

  async function deleteItem(item: Item): Promise<DeleteResult> {
    return item.category === 'likes' ? unlike(item) : deleteViaMenu(item);
  }

  return {
    site: SITE,
    categories: ['posts', 'replies', 'likes'],
    supportsDateFilter: { posts: true, replies: true, likes: false },
    pacing: DEFAULT_BLUESKY_PACING,
    enumerate,
    deleteItem,
  };
}
