/**
 * RunController — the orchestration hub (roadmap task 8). It owns the run loop:
 * enumerate → skip-if-already-gone → pace → delete, with selector self-healing,
 * unexpected-state triage, clean Stop between items, tab-gone pause, and
 * resume-from-log. It is the module the validation gate (task 11) exercises.
 *
 * It depends ONLY on the SiteAdapter interface (injected via adapterFactory);
 * the concrete Bluesky adapter is built in parallel. For its own snapshot /
 * readState / selector-validation needs it creates an RPC client directly from
 * config.tabId — the adapter interface deliberately doesn't expose primitives.
 */
import { createRpcClient } from './rpc';
import { selectorMap } from './selector-map';
import { SelectorMissingError } from './selector-map';
import { AbortError } from './pacing';
import { signatureOf } from './deletion-log';
import { newRunId } from './run-id';
import type { DeletionLog } from './deletion-log';
import type { PacingEngine } from './pacing';
import type {
  Category,
  DeleteResult,
  DomPrimitives,
  Item,
  LlmClient,
  NodeInfo,
  RunConfig,
  RunEvent,
  RunStatus,
  Site,
  SiteAdapter,
} from './types';

export interface RunControllerDeps {
  adapterFactory: (tabId: number) => SiteAdapter;
  log: DeletionLog;
  pacing: PacingEngine;
  /** Optional; when absent, any heal/triage decision degrades to pause-and-notify. */
  llm?: LlmClient;
}

export type RunEventListener = (status: RunStatus, lastEvent?: RunEvent) => void;

/** Trimmed DOM sent to the LLM for selector repair — enough context, bounded cost. */
const SNAPSHOT_MAX_CHARS = 6000;
/** Cap triage cycles per state check so a persistent block ends in a pause, not a loop. */
const MAX_TRIAGE_ROUNDS = 4;
const TAB_GONE = 'tab closed/navigated';

/** Best-effort close controls for triage `dismiss`; clicked via clickDelete (a bare click primitive). */
const CLOSE_SELECTORS = [
  '[data-testid="closeBtn"]',
  '[aria-label="Close"]',
  'button[aria-label*="Close" i]',
  'button[aria-label*="Dismiss" i]',
];

/** Plain-language element descriptions for LLM heal prompts, keyed by selector name. */
const SELECTOR_INTENTS: Record<string, string> = {
  postItem: 'the root container element of a post / feed item',
  replyItem: 'the root container element of a reply feed item',
  likeItem: 'the root container element of a liked post feed item',
  menuButton: "the button that opens a post's options / overflow menu",
  deleteMenuItem: 'the "Delete post" item inside the open post options menu',
  deleteConfirm: 'the confirm button in the delete-confirmation dialog',
  unlikeButton: 'the like / unlike toggle button on a post',
  itemTimestamp: 'the post timestamp element (a time[datetime] node)',
};

const KNOWN_SELECTOR_KEYS = Object.keys(SELECTOR_INTENTS);

/** Thrown internally to unwind the loop into a resumable pause (not markComplete). */
class PauseSignal {
  constructor(readonly reason: string) {}
}
/** Thrown internally to unwind the loop into a clean stop between items (resumable). */
class StopSignal {
  constructor(readonly reason = 'stopped by user') {}
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRpcUnreachable(err: unknown): boolean {
  return messageOf(err).startsWith('RPC_UNREACHABLE:');
}

/** A `failed` DeleteResult whose reason points at a broken selector / vanished element. */
function indicatesMissingSelector(reason: string): boolean {
  return /selector|not found|no element|missing|no match|element/i.test(reason);
}

/** Best-effort recovery of which selector key a string reason refers to. */
function inferSelectorKey(reason: string): string | undefined {
  return KNOWN_SELECTOR_KEYS.find((key) => reason.includes(key));
}

function intentFor(key: string): string {
  return SELECTOR_INTENTS[key] ?? `the element located by the "${key}" selector`;
}

function statePageText(state: { modalPresent: boolean; bannerText?: string }): string {
  const parts = [state.bannerText, state.modalPresent ? 'A modal dialog is open.' : ''];
  return parts.filter(Boolean).join(' ').trim() || 'Unexpected page state.';
}

export class RunController {
  private readonly deps: RunControllerDeps;
  private readonly listeners = new Set<RunEventListener>();

  private status: RunStatus = { state: 'idle' };
  private active = false;

  // Per-run state, (re)initialized in beginRun.
  private config!: RunConfig;
  private site!: Site;
  private runId!: string;
  private adapter!: SiteAdapter;
  private rpc!: DomPrimitives;
  private skipSet = new Set<string>();
  private deleted = 0;
  private stopRequested = false;
  private abortController = new AbortController();

  constructor(deps: RunControllerDeps) {
    this.deps = deps;
  }

  onChange(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): RunStatus {
    return this.status;
  }

  start(config: RunConfig): Promise<void> {
    return this.beginRun(config, false);
  }

  /** Reuse the latest incomplete run's runId (resume) if present, else a fresh one. */
  async resume(config: Omit<RunConfig, 'runId'>): Promise<void> {
    const prior = await this.deps.log.latestIncompleteRun();
    const runId = prior ?? newRunId();
    return this.beginRun({ ...config, runId }, prior !== null);
  }

  /** Clean abort: flip the flag and cut any pending sleep. The loop exits between items. */
  stop(): void {
    if (!this.active) return;
    this.stopRequested = true;
    this.abortController.abort();
  }

  private get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  private async beginRun(config: RunConfig, isResume: boolean): Promise<void> {
    // A double-invoke is a no-op, not a rejection: start()/resume() must never
    // reject, so fire-and-forget callers can't produce an unhandled rejection.
    if (this.active) return;
    this.active = true;

    this.config = config;
    this.site = config.site;
    this.runId = config.runId;
    this.adapter = this.deps.adapterFactory(config.tabId);
    this.rpc = createRpcClient(config.tabId);
    this.stopRequested = false;
    this.abortController = new AbortController();
    this.deps.pacing.resetBackoff();

    try {
      // Resume checkpoint: rebuild the skip-set from what this runId already logged.
      this.skipSet = await this.deps.log.signatures(this.runId);
      this.deleted = this.skipSet.size;

      // A shipped schema bump invalidates stale overrides; record the discard.
      if (await selectorMap.discardStaleOverrides(this.site)) {
        await this.emitEvent('overrides-discarded');
      }

      const firstCat = this.config.categories[0];
      if (firstCat) this.emitRunning(firstCat);
      await this.emitEvent(isResume ? 'resumed' : 'started', this.config.categories.join(', '));

      for (const cat of this.config.categories) {
        if (this.stopRequested) throw new StopSignal();
        await this.runCategory(cat);
      }

      await this.deps.log.markComplete(this.runId);
      this.setStatus({ state: 'done', runId: this.runId, deleted: this.deleted });
      await this.emitEvent('completed', `${this.deleted} deleted`);
    } catch (err) {
      await this.handleTerminal(err);
    } finally {
      this.active = false;
    }
  }

  /** Turn a loop-ending throw into the right terminal status + event. Never rethrows. */
  private async handleTerminal(err: unknown): Promise<void> {
    if (err instanceof StopSignal) {
      this.setStatus({ state: 'paused', runId: this.runId, reason: err.reason, deleted: this.deleted });
      await this.emitEvent('stopped', err.reason);
      return;
    }
    if (err instanceof PauseSignal) {
      this.setStatus({ state: 'paused', runId: this.runId, reason: err.reason, deleted: this.deleted });
      await this.emitEvent('paused', err.reason);
      return;
    }
    // Unexpected: pause (resumable) and record it so the user sees why.
    const reason = messageOf(err);
    this.setStatus({ state: 'paused', runId: this.runId, reason, deleted: this.deleted });
    await this.emitEvent('error', reason);
  }

  /**
   * Drive one category to exhaustion. A SelectorMissingError from enumeration
   * triggers one heal-and-restart (the skip-set makes re-enumeration harmless).
   */
  private async runCategory(cat: Category): Promise<void> {
    this.emitRunning(cat);
    let enumHealed = false;

    while (true) {
      try {
        for await (const item of this.adapter.enumerate(cat, this.config.dateFilter)) {
          if (this.stopRequested) throw new StopSignal();
          await this.processItem(item, cat);
        }
        return;
      } catch (err) {
        if (err instanceof StopSignal || err instanceof PauseSignal) throw err;
        if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
        if (err instanceof SelectorMissingError && !enumHealed) {
          if (!(await this.tryHeal(err.key))) {
            throw new PauseSignal(`selector repair unavailable: ${err.message}`);
          }
          enumHealed = true;
          continue; // restart enumeration once with the healed selector
        }
        throw new PauseSignal(messageOf(err));
      }
    }
  }

  private async processItem(item: Item, cat: Category): Promise<void> {
    const sig = signatureOf(item);
    if (this.skipSet.has(sig)) return; // already deleted/gone under this runId
    if (this.stopRequested) throw new StopSignal();

    // Guard against a modal/banner blocking the delete before we spend a delay on it.
    await this.ensureClearState();

    await this.paced(() => this.deps.pacing.delay(this.abortSignal));

    const result = await this.deleteWithRecovery(item, false);
    this.applyResult(item, sig, result, cat);
  }

  private applyResult(item: Item, sig: string, result: DeleteResult, cat: Category): void {
    if (result.status === 'deleted') {
      this.deleted++;
      this.skipSet.add(sig);
      this.deps.pacing.resetBackoff();
      void this.deps.log.append({
        runId: this.runId,
        site: this.site,
        category: cat,
        textSnippet: item.textSnippet,
        url: item.url,
        deletedAt: new Date().toISOString(),
      });
      this.emitRunning(cat);
      return;
    }
    if (result.status === 'skipped') {
      // Already gone (resume re-encounter) — treat as success, no counter bump.
      this.skipSet.add(sig);
      return;
    }
    // Should not reach here: deleteWithRecovery converts failures to success or a signal.
    throw new PauseSignal(`delete failed: ${result.reason}`);
  }

  /**
   * Delete one item, recovering once from a broken selector (heal + retry) or a
   * blocking state (triage + retry). A second failure, or no recovery path,
   * pauses. RPC_UNREACHABLE anywhere pauses with the tab-gone reason.
   */
  private async deleteWithRecovery(item: Item, retried: boolean): Promise<DeleteResult> {
    let result: DeleteResult;
    try {
      result = await this.adapter.deleteItem(item);
    } catch (err) {
      if (err instanceof StopSignal || err instanceof PauseSignal) throw err;
      if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
      if (err instanceof SelectorMissingError) {
        if (retried) throw new PauseSignal(`selector repair failed: ${err.message}`);
        if (!(await this.tryHeal(err.key, item))) {
          throw new PauseSignal(`selector repair unavailable: ${err.message}`);
        }
        return this.deleteWithRecovery(item, true);
      }
      throw new PauseSignal(messageOf(err));
    }

    if (result.status !== 'failed') return result;
    if (retried) throw new PauseSignal(`delete failed after recovery: ${result.reason}`);

    if (indicatesMissingSelector(result.reason)) {
      const key = inferSelectorKey(result.reason);
      if (!(await this.tryHeal(key, item))) {
        throw new PauseSignal(`selector repair unavailable: ${result.reason}`);
      }
      return this.deleteWithRecovery(item, true);
    }

    // Non-selector failure — maybe an unexpected state blocked it. Triage, then retry once.
    await this.ensureClearState(true);
    return this.deleteWithRecovery(item, true);
  }

  /**
   * Selector self-healing: snapshot around the item → ask the LLM for a
   * replacement → validate it matches ≥1 live node → persist as an override and
   * log. Returns false (→ caller pauses) with no LLM, no key, or a bad proposal.
   */
  private async tryHeal(key: string | undefined, item?: Item): Promise<boolean> {
    if (!this.deps.llm || !key) return false;
    if (!(await this.deps.llm.available())) return false;

    let failedSelector: string;
    try {
      failedSelector = await selectorMap.get(this.site, key);
    } catch {
      failedSelector = key;
    }

    let snapshotHtml: string;
    try {
      const snap = await this.rpc.domSnapshot({ selector: item?.elementKey, maxChars: SNAPSHOT_MAX_CHARS });
      snapshotHtml = snap.html;
    } catch (err) {
      if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
      return false;
    }

    const proposal = await this.deps.llm.healSelector({
      snapshotHtml,
      intent: intentFor(key),
      failedSelector,
    });
    if (!proposal) return false;

    // Validate against the live DOM before caching: it must locate something.
    let nodes: NodeInfo[];
    try {
      nodes = await this.rpc.queryItems({ selector: proposal });
    } catch (err) {
      if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
      return false;
    }
    if (nodes.length === 0) return false;

    await selectorMap.setOverride(this.site, key, proposal);
    await this.emitEvent('selector-healed', `${key}: ${failedSelector} → ${proposal}`);
    return true;
  }

  /**
   * Detect and clear an unexpected page state (modal / banner). Normal state
   * returns immediately. A block is routed through llm.triageState and acted on:
   * dismiss (close & re-check), backoff (wait & re-check), pause_for_human
   * (pause), abort (stop). No LLM → pause. Persistent block → pause.
   */
  private async ensureClearState(_afterFailure = false): Promise<void> {
    for (let round = 0; round < MAX_TRIAGE_ROUNDS; round++) {
      let state;
      try {
        state = await this.rpc.readState();
      } catch (err) {
        if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
        throw new PauseSignal(messageOf(err));
      }
      if (!state.modalPresent && !state.bannerText) return; // clear

      if (!this.deps.llm || !(await this.deps.llm.available())) {
        throw new PauseSignal(`unexpected state: ${statePageText(state)}`);
      }
      const action = await this.deps.llm.triageState({ pageText: statePageText(state) });
      if (action === 'dismiss') {
        await this.attemptDismiss();
        continue;
      }
      if (action === 'backoff') {
        await this.paced(() => this.deps.pacing.backoff(this.abortSignal));
        continue;
      }
      if (action === 'pause_for_human') {
        throw new PauseSignal(`triage pause_for_human: ${statePageText(state)}`);
      }
      // action === 'abort'
      throw new StopSignal('aborted by triage');
    }
    throw new PauseSignal('unexpected state persisted after triage');
  }

  /** Best-effort modal close: click the first matching close control, then let the loop re-check. */
  private async attemptDismiss(): Promise<void> {
    for (const selector of CLOSE_SELECTORS) {
      try {
        const nodes = await this.rpc.queryItems({ selector });
        if (nodes.length > 0) {
          await this.rpc.clickDelete({ menuItemSelector: selector });
          await this.paced(() => this.deps.pacing.delay(this.abortSignal));
          return;
        }
      } catch (err) {
        if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
        // ignore a single bad close selector; try the next
      }
    }
    // Nothing to click — wait a beat; the next state read decides whether it cleared.
    await this.paced(() => this.deps.pacing.delay(this.abortSignal));
  }

  /** Run a pacing sleep, translating an aborted sleep (Stop) into a StopSignal. */
  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AbortError) throw new StopSignal();
      throw err;
    }
  }

  private emitRunning(category: Category): void {
    this.setStatus({ state: 'running', runId: this.runId, deleted: this.deleted, category });
  }

  private setStatus(status: RunStatus): void {
    this.status = status;
    this.notify(undefined);
  }

  private async emitEvent(kind: RunEvent['kind'], detail?: string): Promise<void> {
    const event: RunEvent = { runId: this.runId, at: new Date().toISOString(), kind, detail };
    await this.deps.log.appendEvent(event);
    this.notify(event);
  }

  private notify(event: RunEvent | undefined): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.status, event);
      } catch {
        // a listener throwing must never derail the run
      }
    }
  }
}
