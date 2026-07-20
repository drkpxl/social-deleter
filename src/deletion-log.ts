import { browser } from 'wxt/browser';
import type { Item, LogEntry, RunEvent } from './types';

/**
 * Append-only deletion log over chrome.storage.local, keyed by runId. It is the
 * safety net (a record of what's gone) and the resume checkpoint.
 *
 * Storage layout (per runId):
 *   logmeta:<runId>      -> LogMeta index (chunk/count bookkeeping + complete flag)
 *   log:<runId>:<n>      -> LogEntry[]  (up to CHUNK_SIZE entries per chunk)
 *   events:<runId>:<n>   -> RunEvent[]  (parallel chunked stream)
 *
 * Why chunks: chrome.storage.local rewrites a whole value on every set and has a
 * ~10MB quota. Chunking bounds each append's rewrite to the last (partial) chunk
 * instead of the growing whole-run array.
 */

const CHUNK_SIZE = 200;

interface LogMeta {
  chunks: number;
  count: number;
  eventChunks: number;
  eventCount: number;
  complete: boolean;
  startedAt: string;
}

const metaKey = (runId: string) => `logmeta:${runId}`;
const logKey = (runId: string, n: number) => `log:${runId}:${n}`;
const eventKey = (runId: string, n: number) => `events:${runId}:${n}`;

/**
 * Normalized resume signature: lowercased, whitespace-collapsed textSnippet +
 * '|' + (url ?? ''). Shared with the adapter so an enumerated Item and a logged
 * entry hash identically. Accepts anything carrying textSnippet + optional url.
 */
export function signatureOf(item: Pick<Item | LogEntry, 'textSnippet' | 'url'>): string {
  const snippet = item.textSnippet.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${snippet}|${item.url ?? ''}`;
}

export class DeletionLog {
  private readonly chunkSize: number;
  /** Serializes writes so sequential appends never lose an entry to a read-modify-write race. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(chunkSize = CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  append(entry: LogEntry): Promise<void> {
    return this.enqueue(async () => {
      const meta = await this.loadMeta(entry.runId);
      const { index, chunk } = await this.tailChunk(logKey, entry.runId, meta.chunks);
      chunk.push(entry);
      await browser.storage.local.set({
        [logKey(entry.runId, index)]: chunk,
        [metaKey(entry.runId)]: { ...meta, chunks: index + 1, count: meta.count + 1 },
      });
    });
  }

  appendEvent(event: RunEvent): Promise<void> {
    return this.enqueue(async () => {
      const meta = await this.loadMeta(event.runId);
      const { index, chunk } = await this.tailChunk(eventKey, event.runId, meta.eventChunks);
      chunk.push(event);
      await browser.storage.local.set({
        [eventKey(event.runId, index)]: chunk,
        [metaKey(event.runId)]: { ...meta, eventChunks: index + 1, eventCount: meta.eventCount + 1 },
      });
    });
  }

  async readAll(runId: string): Promise<LogEntry[]> {
    const meta = await this.readMeta(runId);
    if (!meta) return [];
    return this.readChunks<LogEntry>(logKey, runId, meta.chunks);
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    const meta = await this.readMeta(runId);
    if (!meta) return [];
    return this.readChunks<RunEvent>(eventKey, runId, meta.eventChunks);
  }

  /** Set of normalized signatures of already-deleted items, for resume skip. */
  async signatures(runId: string): Promise<Set<string>> {
    const entries = await this.readAll(runId);
    return new Set(entries.map(signatureOf));
  }

  markComplete(runId: string): Promise<void> {
    return this.enqueue(async () => {
      const meta = await this.readMeta(runId);
      if (!meta) return;
      await browser.storage.local.set({ [metaKey(runId)]: { ...meta, complete: true } });
    });
  }

  async listRuns(): Promise<{ runId: string; startedAt: string; count: number; complete: boolean }[]> {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const runs: { runId: string; startedAt: string; count: number; complete: boolean }[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('logmeta:')) continue;
      const meta = value as LogMeta;
      runs.push({
        runId: key.slice('logmeta:'.length),
        startedAt: meta.startedAt,
        count: meta.count,
        complete: meta.complete,
      });
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Most recent run left incomplete (for resume-on-start), or null. */
  async latestIncompleteRun(): Promise<string | null> {
    const runs = await this.listRuns();
    const incomplete = runs.filter((r) => !r.complete);
    return incomplete.length ? incomplete[incomplete.length - 1].runId : null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  private async loadMeta(runId: string): Promise<LogMeta> {
    return (
      (await this.readMeta(runId)) ?? {
        chunks: 0,
        count: 0,
        eventChunks: 0,
        eventCount: 0,
        complete: false,
        startedAt: new Date().toISOString(),
      }
    );
  }

  private async readMeta(runId: string): Promise<LogMeta | undefined> {
    const key = metaKey(runId);
    const got = await browser.storage.local.get(key);
    return got[key] as LogMeta | undefined;
  }

  /** Load the last (partial) chunk, or a fresh empty one, rolling over when full. */
  private async tailChunk(
    key: (runId: string, n: number) => string,
    runId: string,
    chunks: number,
  ): Promise<{ index: number; chunk: unknown[] }> {
    if (chunks === 0) return { index: 0, chunk: [] };
    const index = chunks - 1;
    const k = key(runId, index);
    const got = await browser.storage.local.get(k);
    const chunk = (got[k] as unknown[] | undefined) ?? [];
    if (chunk.length >= this.chunkSize) return { index: index + 1, chunk: [] };
    return { index, chunk };
  }

  private async readChunks<T>(
    key: (runId: string, n: number) => string,
    runId: string,
    chunks: number,
  ): Promise<T[]> {
    if (chunks === 0) return [];
    const keys = Array.from({ length: chunks }, (_, n) => key(runId, n));
    const got = await browser.storage.local.get(keys);
    const out: T[] = [];
    for (const k of keys) {
      const chunk = got[k] as T[] | undefined;
      if (chunk) out.push(...chunk);
    }
    return out;
  }
}
