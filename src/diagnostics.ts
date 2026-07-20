/**
 * Selector diagnostics — dumps what each shipped selector actually matches on
 * the live page, plus a real DOM sample. This is the ground truth that replaces
 * guessing at selectors from memory.
 *
 * Read-only: it queries and snapshots, never clicks or deletes.
 */
import { createRpcClient } from './rpc';
import { selectorMap } from './selector-map';
import shippedBluesky from './selectors/bluesky.json';
import type { Site } from './types';

/** Selectors that only exist while a menu/dialog is open — 0 matches is expected. */
const MENU_ONLY_KEYS = new Set(['deleteMenuItem', 'deleteConfirm', 'undoRepostMenuItem']);

/** Item-root keys, in preference order, for choosing which node to sample. */
const ITEM_KEYS = ['postItem', 'repostItem', 'replyItem', 'likeItem'];

/** Profile tab keys — the controls that select a category (tabs are client-side state). */
const TAB_KEYS = ['tabPosts', 'tabReplies', 'tabLikes'];

const SAMPLE_MAX_CHARS = 3500;
const PAGE_SAMPLE_MAX_CHARS = 2500;

function selectorKeys(site: Site): string[] {
  if (site !== 'bluesky') throw new Error(`No shipped selectors for site "${site}"`);
  return Object.keys(shippedBluesky.selectors);
}

/**
 * Build a paste-ready report of live selector matches for `tabId`.
 * Safe to run at any time; performs no mutations beyond queryItems' key stamping.
 */
export async function collectDiagnostics(tabId: number, site: Site = 'bluesky'): Promise<string> {
  const rpc = createRpcClient(tabId);
  const lines: string[] = [];
  const state = await rpc.readState();

  lines.push('=== social-deleter diagnostics ===');
  lines.push(`url: ${state.url}`);
  lines.push(`schemaVersion: ${shippedBluesky.schemaVersion}`);
  lines.push(`modalPresent: ${state.modalPresent}`);
  if (state.bannerText) lines.push(`banner: ${state.bannerText}`);
  lines.push('');
  lines.push('--- selector match counts ---');

  const counts = new Map<string, number>();
  for (const key of selectorKeys(site)) {
    let selector = '(unresolved)';
    let note = '';
    let count = -1;
    try {
      selector = await selectorMap.get(site, key);
      count = (await rpc.queryItems({ selector })).length;
      counts.set(key, count);
      if (count === 0 && MENU_ONLY_KEYS.has(key)) note = '  (expected 0 — only present while a menu is open)';
      else if (count === 0) note = '  <-- NO MATCH';
    } catch (err) {
      note = `  <-- ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    lines.push(`${key}: ${count < 0 ? '?' : count}${note}`);
    lines.push(`    ${selector}`);
  }

  // Sample a real item so selector guesses can be replaced with actual markup.
  const sampleKey = ITEM_KEYS.find((k) => (counts.get(k) ?? 0) > 0);
  lines.push('');
  if (sampleKey) {
    const selector = await selectorMap.get(site, sampleKey);
    const nodes = await rpc.queryItems({ selector });
    const first = nodes[0];
    lines.push(`--- sample item DOM (${sampleKey}, 1 of ${nodes.length}) ---`);
    if (first) {
      lines.push(`textSnippet: ${first.textSnippet}`);
      lines.push(`url: ${first.url ?? '(none found)'}`);
      lines.push(`timestamp: ${first.timestamp ?? '(none found)'}`);
      lines.push('');
      const snap = await rpc.domSnapshot({ selector: first.elementKey, maxChars: SAMPLE_MAX_CHARS });
      lines.push(snap.html);
    }
  } else {
    // No item root matched — dump page structure so the real container is visible.
    lines.push('--- NO item selector matched; page sample follows ---');
    const snap = await rpc.domSnapshot({ maxChars: PAGE_SAMPLE_MAX_CHARS });
    lines.push(snap.html);
  }

  // Profile tabs are client-side state (the URL never changes), so the adapter
  // reaches a category by clicking the tab whose visible text matches. Dump every
  // candidate's text so a label mismatch is immediately obvious.
  lines.push('');
  lines.push('--- profile tabs ---');
  // Replies/Likes tabs only exist on your OWN profile while logged in, so a 0
  // here usually means the wrong profile, not a broken selector.
  for (const key of TAB_KEYS) {
    try {
      const selector = await selectorMap.get(site, key);
      const hits = await rpc.queryItems({ selector });
      const text = hits[0] ? `  text: "${hits[0].textSnippet}"` : '';
      lines.push(`${key}: ${hits.length}${hits.length === 0 ? '  <-- NO MATCH' : ''}${text}`);
      lines.push(`    ${selector}`);
    } catch (err) {
      lines.push(`${key}: ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Every tab in the bar, so a renamed/missing label shows up immediately.
  const allTabs = await rpc.queryItems({ selector: '[role="tablist"][data-testid="profilePager"] [role="tab"]' });
  lines.push(`tabs present (${allTabs.length}): ${allTabs.map((t) => `"${t.textSnippet}"`).join(', ') || '(none)'}`);

  lines.push('');
  lines.push('--- profile tab bar markup ---');
  let tabsFound = false;
  for (const sel of ['[role="tablist"]', 'nav[role="navigation"]', '[data-testid="profilePager"]']) {
    const hits = await rpc.queryItems({ selector: sel });
    if (hits.length === 0) continue;
    tabsFound = true;
    const snap = await rpc.domSnapshot({ selector: hits[0]!.elementKey, maxChars: 2200 });
    lines.push(`(matched ${sel})`);
    lines.push(snap.html);
    break;
  }
  if (!tabsFound) lines.push('(no tablist/nav matched — the tab selectors likely need updating)');

  // Timestamp element: Bluesky renders relative text, so find the post permalink anchor.
  lines.push('');
  lines.push('--- timestamp / permalink anchor ---');
  const tsHits = await rpc.queryItems({ selector: 'a[href*="/post/"]' });
  lines.push(`a[href*="/post/"] matches: ${tsHits.length}`);
  if (tsHits[0]) {
    const snap = await rpc.domSnapshot({ selector: tsHits[0].elementKey, maxChars: 1600 });
    lines.push(snap.html);
  }

  lines.push('');
  lines.push('=== end diagnostics ===');
  return lines.join('\n');
}
