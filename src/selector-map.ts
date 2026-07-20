/**
 * Selector map — versioned plain data with a runtime override layer.
 * See docs/02-architecture.md "Selector map — concrete shape and lifecycle".
 *
 * Resolution order: override (only when its schemaVersion matches the shipped
 * map) → shipped → throw SelectorMissingError. The caller turns a miss into an
 * LLM-heal attempt and, failing that, a pause — that logic is not here.
 */
import { browser } from 'wxt/browser';
import type { Site, SelectorMapData, SelectorResolver } from './types';
import blueskySelectors from './selectors/bluesky.json';

/** Shipped maps, statically imported. Sites not yet shipped are absent. */
const SHIPPED: Partial<Record<Site, SelectorMapData>> = {
  bluesky: blueskySelectors as SelectorMapData,
};

/** storage.local key holding the override map for a site. */
const overrideKey = (site: Site): string => `selectorOverrides:${site}`;

/** Thrown when neither an override nor the shipped map resolves a key. */
export class SelectorMissingError extends Error {
  constructor(
    readonly site: Site,
    readonly key: string,
  ) {
    super(`No selector for "${key}" on ${site} (override and shipped both missing)`);
    this.name = 'SelectorMissingError';
  }
}

function requireShipped(site: Site): SelectorMapData {
  const shipped = SHIPPED[site];
  if (!shipped) {
    throw new Error(`No shipped selector map for site "${site}"`);
  }
  return shipped;
}

export class SelectorMap implements SelectorResolver {
  /**
   * In-memory copy of the stored override per site. This panel context is the
   * only writer, so the cache is authoritative between writes; the
   * storage.onChanged subscription below only covers a second panel instance.
   * `undefined` value = cached absence, missing key = not yet read.
   */
  private readonly cache = new Map<Site, SelectorMapData | undefined>();
  private watching = false;

  private watchStorage(): void {
    if (this.watching) return;
    this.watching = true;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const site of [...this.cache.keys()]) {
        if (overrideKey(site) in changes) this.cache.delete(site);
      }
    });
  }

  private async readOverride(site: Site): Promise<SelectorMapData | undefined> {
    this.watchStorage();
    if (this.cache.has(site)) return this.cache.get(site);
    const stored = await browser.storage.local.get(overrideKey(site));
    const override = stored[overrideKey(site)] as SelectorMapData | undefined;
    this.cache.set(site, override);
    return override;
  }

  async get(site: Site, key: string): Promise<string> {
    const shipped = requireShipped(site);

    const override = await this.readOverride(site);
    if (override && override.schemaVersion === shipped.schemaVersion) {
      const selector = override.selectors[key];
      if (selector) return selector;
    }

    const selector = shipped.selectors[key];
    if (selector) return selector;

    throw new SelectorMissingError(site, key);
  }

  async setOverride(site: Site, key: string, selector: string): Promise<void> {
    const shipped = requireShipped(site);
    const override = await this.readOverride(site);

    // Only carry forward existing overrides at the current schema; a stale
    // override starts fresh rather than mixing versions.
    const base =
      override && override.schemaVersion === shipped.schemaVersion ? override.selectors : {};

    const next: SelectorMapData = {
      schemaVersion: shipped.schemaVersion,
      selectors: { ...base, [key]: selector },
    };
    await browser.storage.local.set({ [overrideKey(site)]: next });
    this.cache.set(site, next);
  }

  /** Drop overrides whose schemaVersion no longer matches shipped. Returns whether a discard happened. */
  async discardStaleOverrides(site: Site): Promise<boolean> {
    const shipped = requireShipped(site);
    const override = await this.readOverride(site);
    if (override && override.schemaVersion !== shipped.schemaVersion) {
      await browser.storage.local.remove(overrideKey(site));
      this.cache.set(site, undefined);
      return true;
    }
    return false;
  }
}

/** Shared resolver instance for the panel-side orchestrator. */
export const selectorMap = new SelectorMap();
