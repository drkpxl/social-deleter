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
import { navigateTab } from '../navigation';
import { DEFAULT_BLUESKY_PACING } from '../pacing';
import { messageOf } from '../errors';

const SITE: Site = 'bluesky';

/** Item-root selector key per category (resolved via the selector map). */
export const ITEM_SELECTOR_KEY: Record<Category, string> = {
  posts: 'postItem',
  reposts: 'repostItem',
  replies: 'replyItem',
  likes: 'likeItem',
};

/**
 * The selector that opens/performs the delete for each category — the one the
 * controller heals when items enumerate but none turn out deletable. Reposts
 * name the repost button rather than `undoRepostMenuItem`: the button is the
 * gate, and a healed button is what lets the menu item be reached at all.
 */
export const DELETE_CONTROL_SELECTOR_KEY: Record<Category, string> = {
  posts: 'menuButton',
  reposts: 'repostButton',
  replies: 'menuButton',
  likes: 'unlikeButton',
};

/**
 * Single source of truth for date-filter support — the adapter and the UI both
 * read it, so neither can drift into hardcoding category names.
 * Reposts expose the ORIGINAL post's date, not when it was reposted; likes
 * expose no date at all.
 */
export const SUPPORTS_DATE_FILTER: Record<Category, boolean> = {
  posts: true,
  reposts: false,
  replies: true,
  likes: false,
};

/** Profile sub-route per category; posts live on the bare profile page. */
const ROUTE_SUFFIX: Record<Category, string> = {
  posts: '',
  reposts: '',
  replies: '/replies',
  likes: '/likes',
};

/** Categories whose feed interleaves reposts and so must be classified per node. */
const REPOST_AWARE: ReadonlySet<Category> = new Set<Category>(['posts', 'reposts']);

/** Consecutive no-new-item rounds tolerated before giving up (infinite-loop guard). */
const MAX_NO_PROGRESS = 3;

/** Extract `<handle>` from a bsky.app `/profile/<handle>/...` URL. */
export function handleFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== 'bsky.app') return undefined;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'profile') return undefined;
  return segments[1];
}

export function routeFor(category: Category, handle: string): string {
  return `https://bsky.app/profile/${handle}${ROUTE_SUFFIX[category]}`;
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

  /** The run is pinned to one tab; the profile it shows tells us whose content to walk. */
  async function currentHandle(): Promise<string> {
    const state = await rpc.readState();
    const handle = handleFromUrl(state.url);
    if (!handle) {
      throw new Error(
        `Open your Bluesky profile page (bsky.app/profile/<handle>) in this tab before deleting — current URL: ${state.url}`,
      );
    }
    return handle;
  }

  async function* enumerate(category: Category, dateFilter: DateFilter): AsyncIterable<Item> {
    // Each category lives on its own profile route; without this every category
    // would re-scan whatever tab happened to be showing.
    await navigateTab(tabId, routeFor(category, await currentHandle()));

    const selector = await resolve(ITEM_SELECTOR_KEY[category]);
    const timestampSelector = await resolve('itemTimestamp');
    const probes = REPOST_AWARE.has(category)
      ? { isRepost: await resolve('repostIndicator') }
      : undefined;
    const applyDate = SUPPORTS_DATE_FILTER[category];
    // Dedupe by content signature, not elementKey: queryItems restamps
    // data-sd-key on every call (global counter), so a re-queried node returns a
    // different elementKey each round. The signature (snippet|url) is stable and
    // is the same identity the deletion log uses for resume skips.
    const yielded = new Set<string>();
    let noProgress = 0;
    let reachedEnd = false;

    while (true) {
      const nodes = await rpc.queryItems({ selector, timestampSelector, ...(probes ? { probes } : {}) });
      let newThisRound = 0;

      for (const node of nodes) {
        const item = toItem(category, node);
        const signature = signatureOf(item);
        if (yielded.has(signature)) continue;
        yielded.add(signature);
        newThisRound++;
        // Reposts interleave into the Posts feed but need undo-repost, not
        // delete — each category takes only its own half of that feed.
        if (probes) {
          const isRepost = node.probes?.isRepost === true;
          if (category === 'posts' && isRepost) continue;
          if (category === 'reposts' && !isRepost) continue;
        }
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

  async function undoRepost(item: Item): Promise<DeleteResult> {
    const repostButton = await resolve('repostButton');
    const undoMenuItem = await resolve('undoRepostMenuItem');
    // The repost button opens a dropdown; "Undo repost" lives there. Scope the
    // button to this item's stamped root, but not the menu — it renders in a portal.
    try {
      const opened = await rpc.click({ selector: `${item.elementKey} ${repostButton}` });
      if (!opened.ok) return { status: 'skipped', reason: opened.reason ?? 'repost button unavailable' };

      const undone = await rpc.click({ selector: undoMenuItem });
      if (!undone.ok) return { status: 'skipped', reason: undone.reason ?? 'undo repost unavailable' };
      return { status: 'deleted' };
    } catch (err) {
      return { status: 'failed', reason: messageOf(err) };
    }
  }

  async function deleteItem(item: Item): Promise<DeleteResult> {
    if (item.category === 'likes') return unlike(item);
    if (item.category === 'reposts') return undoRepost(item);
    return deleteViaMenu(item);
  }

  return {
    site: SITE,
    categories: ['posts', 'reposts', 'replies', 'likes'],
    supportsDateFilter: SUPPORTS_DATE_FILTER,
    itemSelectorKey: ITEM_SELECTOR_KEY,
    deleteControlSelectorKey: DELETE_CONTROL_SELECTOR_KEY,
    pacing: DEFAULT_BLUESKY_PACING,
    enumerate,
    deleteItem,
  };
}
