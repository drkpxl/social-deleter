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
 *   runIndex             -> RunIndexEntry[] (so listRuns never scans all of storage)
 *
 * Why chunks: chrome.storage.local rewrites a whole value on every set and has a
 * ~10MB quota. Chunking bounds each append's rewrite to the last (partial) chunk
 * instead of the growing whole-run array.
 *
 * Why the in-memory RunState: a run appends thousands of times and this instance
 * is the sole mutator, so meta + the open tail chunks are kept in memory and each
 * append is a single set with no reads. Any failed write drops the memo so the
 * next append re-reads storage and self-heals.
 */

const CHUNK_SIZE = 200;

interface LogMeta {
  chunks: number;
  count: number;
  eventChunks: number;
  complete: boolean;
  startedAt: string;
}

interface RunIndexEntry {
  runId: string;
  startedAt: string;
  complete: boolean;
}

/** Authoritative in-memory mirror of one run's storage state. */
interface RunState {
  runId: string;
  meta: LogMeta;
  logTailIndex: number;
  logTail: LogEntry[];
  eventTailIndex: number;
  eventTail: RunEvent[];
  /** Set while this run is not yet persisted in the run index. */
  needsIndexWrite: boolean;
}

const META_PREFIX = 'logmeta:';
const RUN_INDEX_KEY = 'runIndex';
const metaKey = (runId: string) => `${META_PREFIX}${runId}`;
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
  private state?: RunState;
  private runIndex?: RunIndexEntry[];

  constructor(chunkSize = CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  append(entry: LogEntry): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.loadState(entry.runId);
      if (state.logTail.length >= this.chunkSize) {
        state.logTailIndex += 1;
        state.logTail = [];
      }
      state.logTail.push(entry);
      const meta: LogMeta = {
        ...state.meta,
        chunks: state.logTailIndex + 1,
        count: state.meta.count + 1,
      };
      await this.commit(state, {
        [logKey(entry.runId, state.logTailIndex)]: state.logTail,
        [metaKey(entry.runId)]: meta,
      });
      state.meta = meta;
    });
  }

  appendEvent(event: RunEvent): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.loadState(event.runId);
      if (state.eventTail.length >= this.chunkSize) {
        state.eventTailIndex += 1;
        state.eventTail = [];
      }
      state.eventTail.push(event);
      const meta: LogMeta = { ...state.meta, eventChunks: state.eventTailIndex + 1 };
      await this.commit(state, {
        [eventKey(event.runId, state.eventTailIndex)]: state.eventTail,
        [metaKey(event.runId)]: meta,
      });
      state.meta = meta;
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
      const cached = this.state?.runId === runId ? this.state.meta : undefined;
      const meta = cached ?? (await this.readMeta(runId));
      if (!meta) return;
      const next: LogMeta = { ...meta, complete: true };
      const index = await this.ensureRunIndex();
      const entry = index.find((r) => r.runId === runId);
      if (entry) entry.complete = true;
      else index.push({ runId, startedAt: meta.startedAt, complete: true });
      try {
        await browser.storage.local.set({ [metaKey(runId)]: next, [RUN_INDEX_KEY]: index });
      } catch (err) {
        this.invalidate();
        throw err;
      }
      if (this.state?.runId === runId) this.state.meta = next;
    });
  }

  async listRuns(): Promise<{ runId: string; startedAt: string; count: number; complete: boolean }[]> {
    const index = await this.ensureRunIndex();
    if (!index.length) return [];
    const keys = index.map((r) => metaKey(r.runId));
    const got = (await browser.storage.local.get(keys)) as Record<string, LogMeta | undefined>;
    const runs = index.map((r) => {
      const meta = got[metaKey(r.runId)];
      return {
        runId: r.runId,
        startedAt: meta?.startedAt ?? r.startedAt,
        count: meta?.count ?? 0,
        complete: meta?.complete ?? r.complete,
      };
    });
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

  /** Single write for an append, carrying the run index along on first append. */
  private async commit(state: RunState, values: Record<string, unknown>): Promise<void> {
    if (state.needsIndexWrite) values[RUN_INDEX_KEY] = this.runIndex;
    try {
      await browser.storage.local.set(values);
    } catch (err) {
      this.invalidate();
      throw err;
    }
    state.needsIndexWrite = false;
  }

  private invalidate(): void {
    this.state = undefined;
    this.runIndex = undefined;
  }

  private async loadState(runId: string): Promise<RunState> {
    if (this.state?.runId === runId) return this.state;

    const meta = (await this.readMeta(runId)) ?? {
      chunks: 0,
      count: 0,
      eventChunks: 0,
      complete: false,
      startedAt: new Date().toISOString(),
    };

    const logTailIndex = Math.max(meta.chunks - 1, 0);
    const eventTailIndex = Math.max(meta.eventChunks - 1, 0);
    const wanted = [
      ...(meta.chunks ? [logKey(runId, logTailIndex)] : []),
      ...(meta.eventChunks ? [eventKey(runId, eventTailIndex)] : []),
    ];
    const got = wanted.length
      ? ((await browser.storage.local.get(wanted)) as Record<string, unknown>)
      : {};

    const index = await this.ensureRunIndex();
    let needsIndexWrite = false;
    if (!index.some((r) => r.runId === runId)) {
      index.push({ runId, startedAt: meta.startedAt, complete: meta.complete });
      needsIndexWrite = true;
    }

    this.state = {
      runId,
      meta,
      logTailIndex,
      logTail: (got[logKey(runId, logTailIndex)] as LogEntry[] | undefined) ?? [],
      eventTailIndex,
      eventTail: (got[eventKey(runId, eventTailIndex)] as RunEvent[] | undefined) ?? [],
      needsIndexWrite,
    };
    return this.state;
  }

  /** The run index, migrating once from the old whole-storage scan when absent. */
  private async ensureRunIndex(): Promise<RunIndexEntry[]> {
    if (this.runIndex) return this.runIndex;
    const got = await browser.storage.local.get(RUN_INDEX_KEY);
    const stored = got[RUN_INDEX_KEY] as RunIndexEntry[] | undefined;
    if (stored) {
      this.runIndex = stored;
      return stored;
    }
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const built: RunIndexEntry[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(META_PREFIX)) continue;
      const meta = value as LogMeta;
      built.push({
        runId: key.slice(META_PREFIX.length),
        startedAt: meta.startedAt,
        complete: meta.complete,
      });
    }
    await browser.storage.local.set({ [RUN_INDEX_KEY]: built });
    this.runIndex = built;
    return built;
  }

  private async readMeta(runId: string): Promise<LogMeta | undefined> {
    const key = metaKey(runId);
    const got = await browser.storage.local.get(key);
    return got[key] as LogMeta | undefined;
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
