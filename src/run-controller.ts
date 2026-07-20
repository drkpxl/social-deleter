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
import { AbortError, PacingEngine } from './pacing';
import { signatureOf } from './deletion-log';
import { newRunId } from './run-id';
import { RPC_UNREACHABLE_PREFIX, messageOf } from './errors';
import type { DeletionLog } from './deletion-log';
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
  /** Optional override (tests); by default each run builds one from the adapter's profile. */
  pacing?: PacingEngine;
  /** Optional; when absent, any heal/triage decision degrades to pause-and-notify. */
  llm?: LlmClient;
}

export type RunEventListener = (status: RunStatus, lastEvent?: RunEvent) => void;

/** Trimmed DOM sent to the LLM for selector repair — enough context, bounded cost. */
const SNAPSHOT_MAX_CHARS = 6000;
/** Cap triage cycles per state check so a persistent block ends in a pause, not a loop. */
const MAX_TRIAGE_ROUNDS = 4;
/** Proposals to try per heal before giving up; each is validated against the live DOM. */
const MAX_HEAL_ROUNDS = 3;
const TAB_GONE = 'tab closed/navigated';

/** Selector-map key for the site's modal/toast close controls (triage `dismiss`). */
const DISMISS_SELECTOR_KEY = 'dismissControls';

/**
 * Keys whose element only exists while a menu/dialog is open, in a portal that
 * is NOT inside the item element — an item-scoped snapshot can never contain
 * them, so healing these must look at the open overlay instead.
 */
const MENU_ONLY_KEYS = new Set(['deleteMenuItem', 'deleteConfirm', 'undoRepostMenuItem']);

/**
 * Snapshot anchor for menu-only keys. By the time one of them fails the menu is
 * typically still open, so this captures the portal that holds it; when nothing
 * matches (menu already closed) domSnapshot falls back to the whole page body.
 */
const OVERLAY_SNAPSHOT_SELECTOR = '[role="menu"], [role="dialog"]';

/**
 * What one category actually did, so a run that "succeeds" while deleting
 * nothing can be told apart from real work. `skippedAlreadyLogged` counts items
 * whose signature was already in the skip-set when we reached them — resume
 * re-encounters plus re-encounters of what this category already deleted; both
 * are legitimate and must never read as a broken selector.
 */
interface CategoryOutcome {
  enumerated: number;
  deleted: number;
  skippedAlreadyLogged: number;
  /** Adapter returned `skipped` — the DOM never offered the delete control. */
  skippedByAdapter: number;
  /** Items that arrived with no readable timestamp — a broken date selector shows up here. */
  undated: number;
}

type Suspicion = 'empty' | 'all-skipped';

/**
 * What deleteWithRecovery can hand back: every `failed` path either recovers,
 * throws a signal, or pauses, so the caller's branches exhaust by construction.
 */
type SettledDelete = Exclude<DeleteResult, { status: 'failed' }>;

function newOutcome(): CategoryOutcome {
  return { enumerated: 0, deleted: 0, skippedAlreadyLogged: 0, skippedByAdapter: 0, undated: 0 };
}

/**
 * Classify a finished category. `empty` may be a genuinely empty tab; every
 * `all-skipped` case requires at least one adapter skip and no deletions, so a
 * pure resume pass (everything already logged) stays silent.
 */
function classifySuspicion(outcome: CategoryOutcome): Suspicion | undefined {
  if (outcome.enumerated === 0) return 'empty';
  const attempted = outcome.enumerated - outcome.skippedAlreadyLogged;
  if (
    outcome.deleted === 0 &&
    outcome.skippedByAdapter > 0 &&
    outcome.skippedByAdapter >= attempted
  ) {
    return 'all-skipped';
  }
  return undefined;
}

function suspicionDetail(cat: Category, outcome: CategoryOutcome, suspicion: Suspicion): string {
  return suspicion === 'empty'
    ? `${cat}: found 0 items — the item selector may have changed (or this tab is empty)`
    : `${cat}: found ${outcome.enumerated} items but deleted 0 — the delete control may have changed`;
}

/** Thrown internally to unwind the loop into a resumable pause (not markComplete). */
class PauseSignal {
  constructor(readonly reason: string) {}
}
/** Thrown internally to unwind the loop into a clean stop between items (resumable). */
class StopSignal {
  constructor(readonly reason = 'stopped by user') {}
}

function isRpcUnreachable(err: unknown): boolean {
  return messageOf(err).startsWith(RPC_UNREACHABLE_PREFIX);
}

/**
 * Plain-language description of what a key targets, for the heal prompt. Intents
 * ship alongside the selectors themselves, so a new key can never be added
 * without its description; the generic fallback only covers a key that shipped
 * without one.
 */
async function intentFor(site: Site, key: string): Promise<string> {
  const generic = `the element located by the "${key}" selector`;
  try {
    return (await selectorMap.getIntent(site, key)) ?? generic;
  } catch {
    return generic;
  }
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
  private pacing!: PacingEngine;
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
    // The adapter's profile is authoritative — a site-specific one must not be
    // silently replaced by whoever constructed the controller.
    this.pacing = this.deps.pacing ?? new PacingEngine(this.adapter.pacing);
    this.rpc = createRpcClient(config.tabId);
    this.stopRequested = false;
    this.abortController = new AbortController();
    this.pacing.resetBackoff();

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
    // Every arm is a resumable pause; only the recorded event kind differs.
    const [kind, reason]: [RunEvent['kind'], string] =
      err instanceof StopSignal
        ? ['stopped', err.reason]
        : err instanceof PauseSignal
          ? ['paused', err.reason]
          : ['error', messageOf(err)];
    this.setStatus({ state: 'paused', runId: this.runId, reason, deleted: this.deleted });
    await this.emitEvent(kind, reason);
  }

  /**
   * The pause-don't-crash invariant, in one place: control-flow signals pass
   * through untouched and a dead tab becomes a resumable pause. Every catch in
   * the run loop opens with this; what it does with anything else is its own call.
   */
  private rethrowControlFlow(err: unknown): void {
    if (err instanceof StopSignal || err instanceof PauseSignal) throw err;
    if (isRpcUnreachable(err)) throw new PauseSignal(TAB_GONE);
  }

  /**
   * Drive one category to exhaustion. A SelectorMissingError from enumeration
   * triggers one heal-and-restart (the skip-set makes re-enumeration harmless).
   * `isHealRetry` marks the single permitted post-outcome retry, so a category
   * can never heal-and-retry more than once per run.
   */
  private async runCategory(cat: Category, isHealRetry = false): Promise<void> {
    this.emitRunning(cat);
    let enumHealed = false;
    const outcome = newOutcome();

    while (true) {
      try {
        for await (const item of this.adapter.enumerate(cat, this.config.dateFilter)) {
          if (this.stopRequested) throw new StopSignal();
          await this.processItem(item, cat, outcome);
        }
        break;
      } catch (err) {
        this.rethrowControlFlow(err);
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

    await this.reviewOutcome(cat, outcome, isHealRetry);
  }

  /**
   * A category that deleted nothing is never silent. Emit the `suspicious`
   * event, then — once per category per run, and only with an LLM — try to heal
   * the selector behind the failure and re-run. A failed or unavailable heal
   * leaves the event as the record and moves on: a genuinely empty tab must not
   * block the remaining categories.
   */
  private async reviewOutcome(
    cat: Category,
    outcome: CategoryOutcome,
    isHealRetry: boolean,
  ): Promise<void> {
    // A dateless date-filtered category is its own diagnosis; it would otherwise
    // masquerade as "0 items found" and heal the wrong selector.
    if (await this.reviewTimestamps(cat, outcome, isHealRetry)) return;

    const suspicion = classifySuspicion(outcome);
    if (!suspicion) return;

    await this.emitEvent('suspicious', suspicionDetail(cat, outcome, suspicion));
    if (isHealRetry) return;

    const key =
      suspicion === 'empty'
        ? this.adapter.itemSelectorKey[cat]
        : this.adapter.deleteControlSelectorKey[cat];
    // No item element to anchor on — tryHeal falls back to a page-body snapshot.
    if (await this.tryHeal(key)) {
      await this.runCategory(cat, true);
    }
  }

  /**
   * The silent-no-op bug: under a date-bounded filter the adapter refuses to
   * delete an item it can't date, so a broken timestamp selector filters every
   * item out and the run deletes nothing while looking like an empty tab. Items
   * dropped for having no date never reach us, so confirm against the live DOM:
   * items present + none of them dated ⇒ the timestamp selector is the problem.
   * Returns true when it owned the diagnosis (suppressing the generic ones).
   */
  private async reviewTimestamps(
    cat: Category,
    outcome: CategoryOutcome,
    isHealRetry: boolean,
  ): Promise<boolean> {
    const key = this.adapter.timestampSelectorKey;
    if (!key) return false;
    if (!this.adapter.supportsDateFilter[cat]) return false;
    if (this.config.dateFilter.mode === 'all') return false;
    // Anything dated came through fine — the timestamp selector works.
    if (outcome.enumerated > outcome.undated) return false;

    const probe = await this.probeTimestamps(cat, key);
    if (!probe || probe.items === 0 || probe.dated > 0) return false;

    await this.emitEvent(
      'suspicious',
      `${cat}: ${probe.items} items on the page but none carry a readable date — the ${key} selector may have changed (a date-filtered run would delete nothing)`,
    );
    if (isHealRetry) return true;
    if (await this.tryHeal(key)) await this.runCategory(cat, true);
    return true;
  }

  /** Count live items and how many of them yield a timestamp with the current selectors. */
  private async probeTimestamps(
    cat: Category,
    timestampKey: string,
  ): Promise<{ items: number; dated: number } | undefined> {
    try {
      const selector = await selectorMap.get(this.site, this.adapter.itemSelectorKey[cat]);
      const timestampSelector = await selectorMap.get(this.site, timestampKey);
      const nodes = await this.rpc.queryItems({ selector, timestampSelector });
      return { items: nodes.length, dated: nodes.filter((n) => n.timestamp).length };
    } catch (err) {
      this.rethrowControlFlow(err);
      return undefined;
    }
  }

  private async processItem(item: Item, cat: Category, outcome: CategoryOutcome): Promise<void> {
    const sig = signatureOf(item);
    outcome.enumerated++;
    if (!item.timestamp) outcome.undated++;
    if (this.skipSet.has(sig)) {
      outcome.skippedAlreadyLogged++;
      return; // already deleted/gone under this runId
    }

    // Guard against a modal/banner blocking the delete before we spend a delay on it.
    await this.ensureClearState();

    await this.paced(() => this.pacing.delay(this.abortSignal));

    const result = await this.deleteWithRecovery(item, false);
    this.applyResult(item, sig, result, cat, outcome);
  }

  private applyResult(
    item: Item,
    sig: string,
    result: SettledDelete,
    cat: Category,
    outcome: CategoryOutcome,
  ): void {
    if (result.status === 'deleted') {
      this.deleted++;
      outcome.deleted++;
      this.skipSet.add(sig);
      this.pacing.resetBackoff();
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
    // The DOM offered no control: item already gone, or the selector broke.
    // Indistinguishable here — reviewOutcome decides once the category ends.
    outcome.skippedByAdapter++;
    this.skipSet.add(sig);
  }

  /**
   * Delete one item, recovering once from a broken selector (heal + retry) or a
   * blocking state (triage + retry). A second failure, or no recovery path,
   * pauses. RPC_UNREACHABLE anywhere pauses with the tab-gone reason.
   */
  private async deleteWithRecovery(item: Item, retried: boolean): Promise<SettledDelete> {
    let result: DeleteResult;
    try {
      result = await this.adapter.deleteItem(item);
    } catch (err) {
      this.rethrowControlFlow(err);
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

    // The adapter names the selector behind the failure; no name means it is not
    // a selector problem, and we never guess one from the reason text.
    if (result.selectorKey) {
      if (!(await this.tryHeal(result.selectorKey, item))) {
        throw new PauseSignal(`selector repair unavailable: ${result.reason}`);
      }
      return this.deleteWithRecovery(item, true);
    }

    // Non-selector failure — maybe an unexpected state blocked it. Triage, then retry once.
    await this.ensureClearState();
    return this.deleteWithRecovery(item, true);
  }

  /**
   * Selector self-healing: snapshot around the item (or the whole page body when
   * no item is supplied) → ask the LLM for a replacement → validate it matches
   * ≥1 live node → persist as an override and log. Returns false with no LLM, no
   * key, or a bad proposal; what that means is the caller's call (pause, or —
   * for a suspicious category outcome — just carry on).
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

    const snapshotHtml = await this.snapshotFor(key, item);
    if (snapshotHtml === undefined) return false;
    const intent = await intentFor(this.site, key);

    // Each proposal is validated live; a miss is fed back so the next round
    // can't repeat it. Bounded, so a confused model ends in a pause, not a loop.
    const rejected: string[] = [];
    for (let round = 0; round < MAX_HEAL_ROUNDS; round++) {
      const proposal = await this.deps.llm.healSelector({
        snapshotHtml,
        intent,
        failedSelector,
        rejected,
      });
      if (!proposal) return false;

      let nodes: NodeInfo[] = [];
      try {
        nodes = await this.rpc.queryItems({ selector: proposal });
      } catch (err) {
        this.rethrowControlFlow(err); // a selector the page rejects counts as a miss
      }
      if (nodes.length > 0) {
        await selectorMap.setOverride(this.site, key, proposal);
        await this.emitEvent('selector-healed', `${key}: ${failedSelector} → ${proposal}`);
        return true;
      }
      rejected.push(proposal);
    }
    return false;
  }

  /**
   * Pick what the LLM gets to look at. Menu-only controls live in a portal that
   * exists only while the menu/dialog is open and never inside the item, so an
   * item-scoped snapshot of them is guaranteed empty — those anchor on the open
   * overlay instead, which domSnapshot degrades to the whole page body when the
   * menu has already closed. Everything else stays item-scoped.
   */
  private async snapshotFor(key: string, item?: Item): Promise<string | undefined> {
    const selector = MENU_ONLY_KEYS.has(key) ? OVERLAY_SNAPSHOT_SELECTOR : item?.elementKey;
    try {
      const snap = await this.rpc.domSnapshot({ selector, maxChars: SNAPSHOT_MAX_CHARS });
      return snap.html;
    } catch (err) {
      this.rethrowControlFlow(err);
      return undefined;
    }
  }

  /**
   * Detect and clear an unexpected page state (modal / banner). Normal state
   * returns immediately. A block is routed through llm.triageState and acted on:
   * dismiss (close & re-check), backoff (wait & re-check), pause_for_human
   * (pause), abort (stop). No LLM → pause. Persistent block → pause.
   */
  private async ensureClearState(): Promise<void> {
    for (let round = 0; round < MAX_TRIAGE_ROUNDS; round++) {
      let state;
      try {
        state = await this.rpc.readState();
      } catch (err) {
        this.rethrowControlFlow(err);
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
        await this.paced(() => this.pacing.backoff(this.abortSignal));
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

  /**
   * Best-effort modal close: click the first matching close control, then let
   * the loop re-check. The controls come from the site's selector map (key
   * `dismissControls`), so they are overridable and healable like any other.
   */
  private async attemptDismiss(): Promise<void> {
    try {
      const selector = await selectorMap.get(this.site, DISMISS_SELECTOR_KEY);
      const nodes = await this.rpc.queryItems({ selector });
      if (nodes.length > 0) {
        await this.rpc.clickDelete({ menuItemSelector: selector });
        await this.paced(() => this.pacing.delay(this.abortSignal));
        return;
      }
    } catch (err) {
      this.rethrowControlFlow(err);
      // A missing/bad dismiss selector must not end the run; fall through to the wait.
    }
    // Nothing to click — wait a beat; the next state read decides whether it cleared.
    await this.paced(() => this.pacing.delay(this.abortSignal));
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
