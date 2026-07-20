/**
 * Shared contract for social-deleter. Every module builds against these types.
 * See docs/02-architecture.md — the panel is the brain, the content script is
 * a remote DOM arm speaking only DomPrimitives over RPC.
 */

export type Site = 'bluesky' | 'x' | 'threads';
export type Category = 'posts' | 'replies' | 'likes';

export type DateFilter =
  | { mode: 'all' }
  | { mode: 'olderThan'; date: Date }
  | { mode: 'range'; from: Date; to: Date };

/** A deletable item discovered during enumeration. */
export interface Item {
  site: Site;
  category: Category;
  /** Stable-enough CSS selector or data-key to re-locate the item's root element. */
  elementKey: string;
  textSnippet: string;
  /** Discovered during enumeration when the DOM exposes it; never assumed. */
  url?: string;
  /** Post timestamp when the DOM exposes it (likes views don't). */
  timestamp?: Date;
}

export type DeleteResult =
  | { status: 'deleted' }
  /** Item already gone (e.g. resume re-encounter); treated as success. */
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

// ---------------------------------------------------------------------------
// DOM primitives — the ONLY interface the content script exposes. Stateless.
// ---------------------------------------------------------------------------

export interface NodeInfo {
  /** Selector that re-locates exactly this node (used as Item.elementKey). */
  elementKey: string;
  textSnippet: string;
  url?: string;
  /** ISO 8601, when the DOM exposes a timestamp. */
  timestamp?: string;
}

export interface PageState {
  url: string;
  scrollY: number;
  modalPresent: boolean;
  /** Text of any visible toast/banner (rate limit, error), if present. */
  bannerText?: string;
}

export interface PrimitiveResult {
  ok: boolean;
  reason?: string;
}

/** RPC surface implemented by every site content script. */
export interface DomPrimitives {
  ping(): Promise<'pong'>;
  scroll(args: { direction: 'down' | 'up'; amountPx?: number }): Promise<{ scrolledPx: number; atEnd: boolean }>;
  queryItems(args: { selector: string }): Promise<NodeInfo[]>;
  /** Poll for `selector`, click it. Used for the likes/unlike toggle (no menu). */
  click(args: { selector: string }): Promise<PrimitiveResult>;
  openMenu(args: { itemSelector: string; menuButtonSelector: string }): Promise<PrimitiveResult>;
  clickDelete(args: { menuItemSelector: string; confirmSelector?: string }): Promise<PrimitiveResult>;
  /** Return a trimmed outerHTML snapshot around `selector` (or viewport if omitted) for LLM repair. */
  domSnapshot(args: { selector?: string; maxChars: number }): Promise<{ html: string }>;
  readState(): Promise<PageState>;
}

export type RpcRequest = {
  id: number;
  method: keyof DomPrimitives;
  args?: unknown;
};

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// ---------------------------------------------------------------------------
// Selector map — versioned plain data; shipped JSON + storage overrides.
// ---------------------------------------------------------------------------

export interface SelectorMapData {
  schemaVersion: number;
  /** Named selectors, e.g. postItem, menuButton, deleteMenuItem, deleteConfirm. */
  selectors: Record<string, string>;
}

/** Resolution order: override (schemaVersion must match shipped) → shipped → LLM-heal → pause. */
export interface SelectorResolver {
  get(site: Site, key: string): Promise<string>;
  /** Persist an LLM-healed selector; takes effect immediately. */
  setOverride(site: Site, key: string, selector: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

export interface PacingProfile {
  /** Random delay bounds between actions, ms. */
  minDelayMs: number;
  maxDelayMs: number;
  /** Backoff: delay = base * factor^attempt, capped. */
  backoffBaseMs: number;
  backoffFactor: number;
  backoffMaxMs: number;
}

// ---------------------------------------------------------------------------
// Deletion log — append-only, chrome.storage.local, keyed by runId.
// ---------------------------------------------------------------------------

export interface LogEntry {
  runId: string;
  site: Site;
  category: Category;
  textSnippet: string;
  url?: string;
  /** ISO 8601, when the deletion happened. */
  deletedAt: string;
}

/** Non-item run events also land in the log so the user sees them. */
export interface RunEvent {
  runId: string;
  at: string;
  kind: 'started' | 'stopped' | 'paused' | 'resumed' | 'completed' | 'selector-healed' | 'overrides-discarded' | 'error';
  detail?: string;
}

// ---------------------------------------------------------------------------
// LLM (fallback-only, two jobs)
// ---------------------------------------------------------------------------

export type TriageAction = 'dismiss' | 'backoff' | 'pause_for_human' | 'abort';

export interface LlmConfig {
  /** e.g. http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio) */
  baseUrl: string;
  model: string;
}

export interface LlmClient {
  /** Returns a replacement CSS selector, or null if the model can't produce one. Caller validates against live DOM. */
  healSelector(args: { snapshotHtml: string; intent: string; failedSelector: string }): Promise<string | null>;
  triageState(args: { pageText: string }): Promise<TriageAction>;
  available(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Adapter — panel-side; drives DomPrimitives over RPC.
// ---------------------------------------------------------------------------

export interface SiteAdapter {
  site: Site;
  categories: Category[];
  supportsDateFilter: Record<Category, boolean>;
  /** Panel-side async generator; iteration state lives in its closure. */
  enumerate(cat: Category, dateFilter: DateFilter): AsyncIterable<Item>;
  deleteItem(item: Item): Promise<DeleteResult>;
  pacing: PacingProfile;
}

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

export interface RunConfig {
  site: Site;
  categories: Category[];
  dateFilter: DateFilter;
  tabId: number;
  runId: string;
}

export type RunStatus =
  | { state: 'idle' }
  | { state: 'running'; runId: string; deleted: number; category: Category }
  | { state: 'paused'; runId: string; reason: string }
  | { state: 'done'; runId: string; deleted: number };
