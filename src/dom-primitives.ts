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

async function pollForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  let found: HTMLElement | null = null;
  await pollFor(() => {
    found = document.querySelector<HTMLElement>(selector);
    return found !== null;
  }, timeoutMs);
  return found;
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

function toIso(raw: string): string | undefined {
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function findPermalink(node: Element): string | undefined {
  const anchors = Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const permalink = anchors.find((a) => PERMALINK_HINTS.some((hint) => a.getAttribute('href')?.includes(hint)));
  return permalink?.href || undefined;
}

function findTimestamp(node: Element): string | undefined {
  const timeEl = node.querySelector<HTMLElement>('time[datetime], [datetime]');
  const raw = timeEl?.getAttribute('datetime');
  return raw ? toIso(raw) : undefined;
}

export function createDomPrimitives(): DomPrimitives {
  return {
    async ping() {
      return 'pong';
    },

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

    async queryItems({ selector }) {
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
        const url = findPermalink(node);
        if (url) info.url = url;
        const timestamp = findTimestamp(node);
        if (timestamp) info.timestamp = timestamp;
        return info;
      });
    },

    async openMenu({ itemSelector, menuButtonSelector }): Promise<PrimitiveResult> {
      const item = document.querySelector<HTMLElement>(itemSelector);
      if (!item) return { ok: false, reason: `item not found: ${itemSelector}` };
      const button = item.querySelector<HTMLElement>(menuButtonSelector);
      if (!button) return { ok: false, reason: `menu button not found: ${menuButtonSelector}` };
      button.click();
      const appeared = await pollFor(() => document.querySelector('[role="menu"]') !== null, 500);
      return appeared ? { ok: true } : { ok: false, reason: 'menu did not appear' };
    },

    async click({ selector }): Promise<PrimitiveResult> {
      const el = await pollForElement(selector, 3000);
      if (!el) return { ok: false, reason: `element not found: ${selector}` };
      el.click();
      return { ok: true };
    },

    async clickDelete({ menuItemSelector, confirmSelector }): Promise<PrimitiveResult> {
      const menuItem = await pollForElement(menuItemSelector, 3000);
      if (!menuItem) return { ok: false, reason: `delete item not found: ${menuItemSelector}` };
      menuItem.click();
      if (confirmSelector) {
        const confirm = await pollForElement(confirmSelector, 3000);
        if (!confirm) return { ok: false, reason: `confirm control not found: ${confirmSelector}` };
        confirm.click();
      }
      return { ok: true };
    },

    async domSnapshot({ selector, maxChars }) {
      const target = selector ? document.querySelector(selector) : document.body;
      const root = target ?? document.body;
      const context = selector && root.parentElement ? root.parentElement : root;
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
