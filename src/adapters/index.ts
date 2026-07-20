/**
 * Site registry — the single seam where a site's wiring lives. Everything that
 * used to be scattered (the panel's supported-host check, the adapter factory,
 * the hardcoded `site` in RunConfig, the content-script file baked into the RPC
 * client, the shipped selector map) is resolved from one row here, so adding a
 * site is one entry rather than five edits in five files.
 */
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import type { Category, Site, SiteAdapter } from '../types';
import { createBlueskyAdapter, SUPPORTS_DATE_FILTER as BLUESKY_DATE_FILTER } from './bluesky';
import {
  createThreadsAdapter,
  SUPPORTS_DATE_FILTER as THREADS_DATE_FILTER,
  THREADS_CATEGORIES,
  THREADS_CONTENT_SCRIPT,
  THREADS_HOSTS,
} from './threads';

export interface SiteRegistration {
  site: Site;
  /** Hostnames that identify this site, exact match. */
  hosts: string[];
  /** Display name for UI copy. */
  label: string;
  /**
   * Built content-script bundle, injected on demand when the declarative one is
   * absent. Typed against WXT's generated path union so a typo (or a renamed
   * entrypoint) fails the build instead of silently failing to inject.
   */
  contentScript: ScriptPublicPath;
  factory: (tabId: number) => SiteAdapter;
  /** Categories this site can actually offer (Threads has no likes view). */
  categories: Category[];
  /**
   * Mirrors the adapter's own map. It lives here too because the panel has to
   * enable/disable the date filter BEFORE a run exists (and so before an adapter
   * instance does); both read the same exported constant, so they cannot drift.
   */
  supportsDateFilter: Record<Category, boolean>;
}

export const SITES: SiteRegistration[] = [
  {
    site: 'bluesky',
    hosts: ['bsky.app'],
    label: 'Bluesky',
    contentScript: '/content-scripts/bluesky.js',
    factory: createBlueskyAdapter,
    categories: ['posts', 'reposts', 'replies', 'likes'],
    supportsDateFilter: BLUESKY_DATE_FILTER,
  },
  {
    site: 'threads',
    hosts: THREADS_HOSTS,
    label: 'Threads',
    contentScript: THREADS_CONTENT_SCRIPT,
    factory: createThreadsAdapter,
    categories: THREADS_CATEGORIES,
    supportsDateFilter: THREADS_DATE_FILTER,
  },
];

export function siteForUrl(url: string): SiteRegistration | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return SITES.find((registration) => registration.hosts.includes(hostname));
}

export function registrationFor(site: Site): SiteRegistration | undefined {
  return SITES.find((registration) => registration.site === site);
}
