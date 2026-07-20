import type { DomPrimitives, NodeInfo, PageState, PrimitiveResult } from './types';

const PERMALINK_HINTS = ['/post/', '/status/', '/p/'];

let keyCounter = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollFor(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return true;
    await sleep(stepMs);
  } while (Date.now() < deadline);
  return predicate();
}

/** Thrown when a caller-supplied selector isn't parseable — reported as `bad-selector`. */
class BadSelectorError extends Error {}

function queryOne(root: ParentNode, selector: string): HTMLElement | null {
  try {
    return root.querySelector<HTMLElement>(selector);
  } catch {
    throw new BadSelectorError(`invalid selector: ${selector}`);
  }
}

function queryAll(root: ParentNode, selector: string): HTMLElement[] {
  try {
    return Array.from(root.querySelectorAll<HTMLElement>(selector));
  } catch {
    throw new BadSelectorError(`invalid selector: ${selector}`);
  }
}

async function pollForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  let found: HTMLElement | null = null;
  await pollFor(() => {
    found = queryOne(document, selector);
    return found !== null;
  }, timeoutMs);
  return found;
}

function badSelector(err: unknown, failedArg: string): PrimitiveResult {
  if (!(err instanceof BadSelectorError)) throw err;
  return { ok: false, reason: err.message, code: 'bad-selector', failedArg };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isVisible(el: Element): boolean {
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/**
 * Attributes that may carry a post's date, in preference order. Kept broad on
 * purpose: an LLM-healed selector only points at an element — if the date were
 * read from one hard-coded attribute, a site that moved it would still yield
 * nothing. Bluesky, for example, has no <time datetime> at all; it renders
 * relative text and puts the real date in aria-label/data-tooltip.
 */
const DATE_ATTRS = ['datetime', 'data-tooltip', 'aria-label', 'title'];

function toIso(raw: string): string | undefined {
  // Human-readable forms like "July 19, 2026 at 4:56 PM" need the connector
  // removed before Date.parse will accept them.
  const cleaned = raw.replace(/\s+at\s+/i, ' ').replace(/\s+/g, ' ').trim();
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Caller-supplied selectors are best-effort site knowledge; a malformed one must not abort the query. */
function safeQuery<T extends Element>(node: Element, selector: string): T | null {
  try {
    return node.querySelector<T>(selector);
  } catch {
    return null;
  }
}

/** A caller-supplied selector wins; the generic heuristic stays as fallback. */
function findPermalink(node: Element, selector?: string): string | undefined {
  if (selector) {
    const scoped = safeQuery<HTMLAnchorElement>(node, selector);
    if (scoped?.href) return scoped.href;
  }
  const anchors = Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const permalink = anchors.find((a) => PERMALINK_HINTS.some((hint) => a.getAttribute('href')?.includes(hint)));
  return permalink?.href || undefined;
}

function readDatetime(el: Element | null): string | undefined {
  if (!el) return undefined;
  for (const attr of DATE_ATTRS) {
    const raw = el.getAttribute(attr);
    const iso = raw ? toIso(raw) : undefined;
    if (iso) return iso;
  }
  return undefined;
}

function findTimestamp(node: Element, selector?: string): string | undefined {
  if (selector) {
    const scoped = readDatetime(safeQuery(node, selector));
    if (scoped) return scoped;
  }
  // Fallbacks, most-structured first: a real <time>, then any element carrying a
  // date-bearing attribute (Bluesky's permalink anchor lands in the last group).
  for (const fallback of ['time[datetime], [datetime]', 'a[href*="/post/"][data-tooltip]', 'a[data-tooltip], a[aria-label]']) {
    for (const el of Array.from(node.querySelectorAll(fallback))) {
      const iso = readDatetime(el);
      if (iso) return iso;
    }
  }
  return undefined;
}

function runProbes(node: Element, probes: Record<string, string>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [name, selector] of Object.entries(probes)) {
    result[name] = safeQuery(node, selector) !== null;
  }
  return result;
}

export function createDomPrimitives(): DomPrimitives {
  return {
    async scroll({ direction, amountPx }) {
      const amount = amountPx ?? Math.round(window.innerHeight * 0.9);
      const before = window.scrollY;
      window.scrollBy(0, direction === 'down' ? amount : -amount);
      await sleep(350);
      const after = window.scrollY;
      const scrolledPx = Math.abs(after - before);
      const atBottom = Math.ceil(after + window.innerHeight) >= document.documentElement.scrollHeight;
      const atEnd =
        scrolledPx === 0 || (direction === 'down' ? atBottom : after <= 0);
      return { scrolledPx, atEnd };
    },

    async queryItems({ selector, probes, timestampSelector, permalinkSelector }) {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      return nodes.map((node): NodeInfo => {
        // Reuse an existing key so elementKey stays stable across calls — the
        // heal-retry path re-queries between yield and delete and must not
        // restamp the very node it is about to act on.
        const key = node.getAttribute('data-sd-key') ?? String(keyCounter++);
        node.setAttribute('data-sd-key', key);
        const info: NodeInfo = {
          elementKey: `[data-sd-key="${key}"]`,
          textSnippet: collapse(node.innerText).slice(0, 120),
        };
        const url = findPermalink(node, permalinkSelector);
        if (url) info.url = url;
        const timestamp = findTimestamp(node, timestampSelector);
        if (timestamp) info.timestamp = timestamp;
        if (probes) info.probes = runProbes(node, probes);
        return info;
      });
    },

    async openMenu({ itemSelector, menuButtonSelector }): Promise<PrimitiveResult> {
      let item: HTMLElement | null;
      try {
        item = queryOne(document, itemSelector);
      } catch (err) {
        return badSelector(err, 'itemSelector');
      }
      // A missing item root is the item legitimately vanishing (already deleted,
      // feed re-rendered) — never a broken selector, so never a heal trigger.
      if (!item) return { ok: false, reason: `item not found: ${itemSelector}`, code: 'item-missing', failedArg: 'itemSelector' };

      let button: HTMLElement | null;
      try {
        button = queryOne(item, menuButtonSelector);
      } catch (err) {
        return badSelector(err, 'menuButtonSelector');
      }
      if (!button) {
        return { ok: false, reason: `menu button not found: ${menuButtonSelector}`, code: 'trigger-missing', failedArg: 'menuButtonSelector' };
      }

      button.click();
      const appeared = await pollFor(() => document.querySelector('[role="menu"]') !== null, 500);
      return appeared
        ? { ok: true }
        : { ok: false, reason: 'menu did not appear', code: 'timeout', failedArg: 'menuButtonSelector' };
    },

    async click({ selector }): Promise<PrimitiveResult> {
      let el: HTMLElement | null;
      try {
        el = await pollForElement(selector, 3000);
      } catch (err) {
        return badSelector(err, 'selector');
      }
      if (!el) return { ok: false, reason: `element not found: ${selector}`, code: 'trigger-missing', failedArg: 'selector' };
      el.click();
      return { ok: true };
    },

    async clickByText({ selector, text }): Promise<PrimitiveResult> {
      const wanted = collapse(text).toLowerCase();
      // Held in an object, not a `let`: TS keeps the initializer's narrowing
      // across the poll callback and would type a bare `let` as `null` after it.
      const found: { seen: string[]; target: HTMLElement | null } = { seen: [], target: null };
      try {
        await pollFor(() => {
          const candidates = queryAll(document, selector);
          const texts = candidates.map((el) => collapse(el.innerText ?? el.textContent ?? ''));
          found.seen = texts.filter(Boolean);
          // Exact wins over startsWith, and the fallback only ever considers
          // texts that START WITH the wanted one — never a sibling like
          // "Cancel". Threads' confirm dialog holds two identical-looking
          // [role="button"] DIVs, "Delete" and "Cancel", so this ordering is what
          // keeps the confirm click off Cancel rather than document order.
          const lower = texts.map((t) => t.toLowerCase());
          const exact = lower.indexOf(wanted);
          const index = exact >= 0 ? exact : lower.findIndex((t) => t.startsWith(wanted));
          found.target = index >= 0 ? (candidates[index] ?? null) : null;
          return found.target !== null;
        }, 3000);
      } catch (err) {
        return badSelector(err, 'selector');
      }
      if (!found.target) {
        // Report what WAS there: a text miss is usually a relabelled item, and
        // the visible labels are the only way to see that from the panel.
        const seen = found.seen.length > 0 ? found.seen.map((t) => `"${t}"`).join(', ') : '(none)';
        return {
          ok: false,
          reason: `no element matching "${text}" for ${selector} — visible texts found: ${seen}`,
          code: 'trigger-missing',
          failedArg: 'selector',
        };
      }
      found.target.click();
      return { ok: true };
    },

    async clickDelete({ menuItemSelector, confirmSelector }): Promise<PrimitiveResult> {
      let menuItem: HTMLElement | null;
      try {
        menuItem = await pollForElement(menuItemSelector, 3000);
      } catch (err) {
        return badSelector(err, 'menuItemSelector');
      }
      if (!menuItem) {
        return { ok: false, reason: `delete item not found: ${menuItemSelector}`, code: 'trigger-missing', failedArg: 'menuItemSelector' };
      }
      menuItem.click();
      if (confirmSelector) {
        let confirm: HTMLElement | null;
        try {
          confirm = await pollForElement(confirmSelector, 3000);
        } catch (err) {
          return badSelector(err, 'confirmSelector');
        }
        if (!confirm) {
          return { ok: false, reason: `confirm control not found: ${confirmSelector}`, code: 'trigger-missing', failedArg: 'confirmSelector' };
        }
        confirm.click();
      }
      return { ok: true };
    },

    async domSnapshot({ selector, maxChars }) {
      // Snapshot the matched element's parent (siblings give the LLM context);
      // with no selector — or nothing matched — fall back to the whole body.
      const matched = selector ? document.querySelector(selector) : null;
      const context = matched?.parentElement ?? document.body;
      const clone = context.cloneNode(true) as Element;
      clone.querySelectorAll('script, style, svg').forEach((n) => {
        n.textContent = '';
      });
      let html = clone.outerHTML
        .replace(/data:[^;,\s]*;base64,[A-Za-z0-9+/=]+/g, 'data:base64,…')
        .replace(/\s+/g, ' ')
        .trim();
      if (html.length > maxChars) html = html.slice(0, maxChars);
      return { html };
    },

    async readState(): Promise<PageState> {
      const modalPresent = Array.from(
        document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
      ).some(isVisible);
      const banner = Array.from(document.querySelectorAll('[role="alert"], [role="status"]')).find(isVisible);
      const state: PageState = {
        url: location.href,
        scrollY: window.scrollY,
        modalPresent,
      };
      const bannerText = banner ? collapse((banner as HTMLElement).innerText) : '';
      if (bannerText) state.bannerText = bannerText;
      return state;
    },
  };
}
