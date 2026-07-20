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
  private async readOverride(site: Site): Promise<SelectorMapData | undefined> {
    const stored = await browser.storage.local.get(overrideKey(site));
    return stored[overrideKey(site)] as SelectorMapData | undefined;
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
  }

  /** Drop overrides whose schemaVersion no longer matches shipped. Returns whether a discard happened. */
  async discardStaleOverrides(site: Site): Promise<boolean> {
    const shipped = requireShipped(site);
    const override = await this.readOverride(site);
    if (override && override.schemaVersion !== shipped.schemaVersion) {
      await browser.storage.local.remove(overrideKey(site));
      return true;
    }
    return false;
  }
}

/** Shared resolver instance for the panel-side orchestrator. */
export const selectorMap = new SelectorMap();
