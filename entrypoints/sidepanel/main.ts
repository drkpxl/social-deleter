/**
 * Side-panel UI (roadmap task 9) — the panel is the orchestrator host: it owns
 * the RunController and every long-lived module. Plain DOM, no framework.
 *
 * Safety posture (docs/02-architecture.md "Control flow and safety posture"):
 * Delete starts immediately — no confirmation dialog, no dry-run.
 */
import './style.css';
import { createBlueskyAdapter, SUPPORTS_DATE_FILTER } from '@/src/adapters/bluesky';
import { DeletionLog } from '@/src/deletion-log';
import { createLlmClient, loadLlmConfig, saveLlmConfig } from '@/src/llm-client';
import { DEFAULT_BLUESKY_PACING, PacingEngine } from '@/src/pacing';
import { RunController } from '@/src/run-controller';
import { newRunId } from '@/src/run-id';
import type { Category, DateFilter, LlmClient, RunConfig, RunEvent, RunStatus } from '@/src/types';

/** v1 is Bluesky-only; the active tab must be on this host to run. */
const SUPPORTED_HOST = 'bsky.app';
/** Keep the panel light — a run's log can grow to thousands of entries. */
const MAX_ROWS = 200;
const POLL_MS = 1500;
const SNIPPET_CHARS = 140;

const TEMPLATE = `
  <header>
    <h1>Social Deleter</h1>
    <p id="tab-status" class="tab-status"></p>
  </header>

  <fieldset id="categories">
    <legend>What to delete</legend>
    <label><input type="checkbox" id="cat-posts" checked /> Posts</label>
    <label><input type="checkbox" id="cat-reposts" checked /> Reposts</label>
    <label><input type="checkbox" id="cat-replies" checked /> Replies</label>
    <label><input type="checkbox" id="cat-likes" checked /> Likes</label>
  </fieldset>

  <fieldset id="datefilter">
    <legend>Date filter</legend>
    <select id="date-mode">
      <option value="all">All dates</option>
      <option value="olderThan">Older than</option>
      <option value="range">Range</option>
    </select>
    <div id="date-olderThan" class="date-inputs" hidden>
      <label>Before<input type="date" id="date-before" /></label>
    </div>
    <div id="date-range" class="date-inputs" hidden>
      <label>From<input type="date" id="date-from" /></label>
      <label>To<input type="date" id="date-to" /></label>
    </div>
    <p id="date-note" class="hint"></p>
  </fieldset>

  <div class="actions">
    <button type="button" id="btn-delete" class="btn btn-danger">Delete</button>
    <button type="button" id="btn-stop" class="btn btn-stop">Stop</button>
    <button type="button" id="btn-resume" class="btn btn-resume" hidden>Resume previous run</button>
  </div>

  <section class="progress">
    <div id="progress-state"></div>
  </section>

  <section class="logview">
    <h2>Activity</h2>
    <ul id="log-list"></ul>
  </section>

  <details class="llm">
    <summary>LLM settings (optional)</summary>
    <label>Base URL<input type="text" id="llm-baseurl" placeholder="http://localhost:11434/v1" /></label>
    <label>Model<input type="text" id="llm-model" placeholder="qwen2.5-coder:7b" /></label>
    <small>Ollama: http://localhost:11434/v1 &middot; LM Studio: http://localhost:1234/v1</small>
    <div class="llm-actions">
      <button type="button" id="llm-save" class="btn">Save</button>
      <button type="button" id="llm-test" class="btn">Test</button>
    </div>
    <p id="llm-status" class="hint"></p>
  </details>
`;

interface ActiveTab {
  id: number;
  url: string;
  supported: boolean;
}

interface LogRow {
  at: string;
  text: string;
  isEvent: boolean;
  kind?: RunEvent['kind'];
}

const log = new DeletionLog();
const pacing = new PacingEngine(DEFAULT_BLUESKY_PACING);

let controller: RunController;
let unsubscribe: (() => void) | null = null;
let llmClient: LlmClient | undefined;
let status: RunStatus = { state: 'idle' };
let activeTab: ActiveTab | null = null;
/** Run whose log the Activity list shows (the live run, or a resumable one). */
let displayRunId: string | null = null;
let hasIncompleteRun = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ---------------------------------------------------------------------------
// Controller wiring
// ---------------------------------------------------------------------------

function buildController(): void {
  unsubscribe?.();
  controller = new RunController({
    adapterFactory: createBlueskyAdapter,
    log,
    pacing,
    llm: llmClient,
  });
  unsubscribe = controller.onChange((next) => {
    status = next;
    if (next.state !== 'idle') displayRunId = next.runId;
    if (next.state === 'paused') hasIncompleteRun = true;
    if (next.state === 'done') hasIncompleteRun = false;
    render();
    void refreshLog();
  });
}

/**
 * `paused` is NOT active — the controller has already unwound its loop, so a
 * fresh Start (or an llm swap) is safe there; only `running` holds the loop.
 */
function runActive(): boolean {
  return status.state === 'running';
}

/** start()/resume() are documented as never rejecting, except the already-running guard. */
function launch(run: Promise<void>): void {
  void run.catch((err: unknown) => console.error('run failed to launch', err));
}

// ---------------------------------------------------------------------------
// Form state -> RunConfig
// ---------------------------------------------------------------------------

function selectedCategories(): Category[] {
  const cats: Category[] = [];
  if (el<HTMLInputElement>('cat-posts').checked) cats.push('posts');
  if (el<HTMLInputElement>('cat-reposts').checked) cats.push('reposts');
  if (el<HTMLInputElement>('cat-replies').checked) cats.push('replies');
  if (el<HTMLInputElement>('cat-likes').checked) cats.push('likes');
  return cats;
}

/**
 * Likes render no timestamps and reposts show the original post's date, not the
 * repost's — a run made only of such categories cannot be date-filtered.
 */
function dateFilterUnavailable(cats: Category[]): boolean {
  return cats.length > 0 && !cats.some((cat) => SUPPORTS_DATE_FILTER[cat]);
}

function buildDateFilter(): DateFilter {
  if (dateFilterUnavailable(selectedCategories())) return { mode: 'all' };
  const mode = el<HTMLSelectElement>('date-mode').value;
  if (mode === 'olderThan') {
    const before = el<HTMLInputElement>('date-before').value;
    if (before) return { mode: 'olderThan', date: new Date(before) };
  } else if (mode === 'range') {
    const from = el<HTMLInputElement>('date-from').value;
    const to = el<HTMLInputElement>('date-to').value;
    // A bare `to` date is midnight, which would exclude that whole day.
    if (from && to) return { mode: 'range', from: new Date(from), to: new Date(`${to}T23:59:59.999`) };
  }
  return { mode: 'all' };
}

async function resolveActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    activeTab = null;
    return;
  }
  const url = tab.url ?? '';
  let supported = false;
  try {
    supported = new URL(url).hostname === SUPPORTED_HOST;
  } catch {
    supported = false;
  }
  activeTab = { id: tab.id, url, supported };
}

/** The run is pinned to whichever tab is active at click time. */
function baseConfig(tab: ActiveTab): Omit<RunConfig, 'runId'> {
  return {
    site: 'bluesky',
    categories: selectedCategories(),
    dateFilter: buildDateFilter(),
    tabId: tab.id,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function onDelete(): Promise<void> {
  await resolveActiveTab();
  render();
  if (!activeTab?.supported || selectedCategories().length === 0) return;

  const config: RunConfig = { ...baseConfig(activeTab), runId: newRunId() };
  displayRunId = config.runId;
  hasIncompleteRun = true;
  // Outcomes arrive through onChange, not this promise.
  launch(controller.start(config));
}

function onStop(): void {
  controller.stop();
}

async function onResume(): Promise<void> {
  await resolveActiveTab();
  render();
  if (!activeTab?.supported || selectedCategories().length === 0) return;
  // resume() reuses the latest incomplete runId and rebuilds the skip-set from the log.
  launch(controller.resume(baseConfig(activeTab)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTabStatus(): void {
  const node = el('tab-status');
  if (!activeTab) {
    node.textContent = 'No active tab detected.';
    node.className = 'tab-status warn';
  } else if (!activeTab.supported) {
    node.textContent = 'Active tab is not bsky.app — open Bluesky in this window to run.';
    node.className = 'tab-status warn';
  } else {
    node.textContent = 'Ready on bsky.app';
    node.className = 'tab-status ok';
  }
}

function renderProgress(): void {
  const line = document.createElement('div');
  line.className = 'state-line';
  const detail = document.createElement('div');
  detail.className = 'state-detail';

  if (status.state === 'idle') {
    line.textContent = 'Idle';
    detail.textContent = hasIncompleteRun ? 'A previous run is incomplete.' : '';
  } else if (status.state === 'running') {
    line.classList.add('state-running');
    line.textContent = `Running — ${status.deleted} deleted`;
    detail.textContent = `Category: ${status.category}`;
  } else if (status.state === 'paused') {
    line.classList.add('state-paused');
    line.textContent = `Paused — ${status.deleted} deleted`;
    detail.textContent = status.reason;
  } else {
    // "Done — 0 deleted" alone reads as success; say plainly that nothing happened.
    const nothing = status.deleted === 0;
    line.classList.add(nothing ? 'state-empty' : 'state-done');
    line.textContent = nothing ? 'Done — 0 deleted (nothing matched)' : `Done — ${status.deleted} deleted`;
    detail.textContent = nothing ? 'Check the Activity list for warnings.' : '';
  }

  el('progress-state').replaceChildren(line, detail);
}

function render(): void {
  const cats = selectedCategories();
  const running = runActive();
  const noDates = dateFilterUnavailable(cats);
  const usable = !!activeTab?.supported && cats.length > 0;

  renderTabStatus();

  el<HTMLFieldSetElement>('categories').disabled = running;
  el<HTMLFieldSetElement>('datefilter').disabled = running || noDates;
  el('date-note').textContent = noDates
    ? 'Likes and reposts carry no usable date — date filter unavailable.'
    : '';

  // Paused still allows a fresh Start; Resume sits alongside it as the other path.
  el<HTMLButtonElement>('btn-delete').disabled = !usable || running;
  el<HTMLButtonElement>('btn-stop').disabled = !running;

  const resume = el<HTMLButtonElement>('btn-resume');
  resume.hidden = !(status.state === 'paused' || (status.state === 'idle' && hasIncompleteRun));
  resume.disabled = !usable;

  renderProgress();
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

function renderRows(rows: LogRow[]): void {
  const list = el('log-list');

  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No activity yet.';
    list.replaceChildren(empty);
    return;
  }

  const items = rows.map((row) => {
    const li = document.createElement('li');
    if (row.isEvent) li.className = 'row-event';
    if (row.kind === 'suspicious') li.classList.add('row-suspicious');

    const text = document.createElement('span');
    text.className = 'row-text';
    text.textContent = row.text;
    text.title = row.text;

    const time = document.createElement('span');
    time.className = 'row-time';
    time.textContent = new Date(row.at).toLocaleTimeString();

    li.append(text, time);
    return li;
  });
  list.replaceChildren(...items);
}

async function refreshLog(): Promise<void> {
  const runId = displayRunId;
  if (!runId) {
    renderRows([]);
    return;
  }
  const [entries, events] = await Promise.all([log.readAll(runId), log.readEvents(runId)]);
  if (displayRunId !== runId) return; // a newer run took over mid-read

  const rows: LogRow[] = [
    ...entries.map((entry) => ({
      at: entry.deletedAt,
      text: `${entry.category}: ${truncate(entry.textSnippet)}`,
      isEvent: false,
    })),
    ...events.map((event) => ({
      at: event.at,
      text: event.detail ? `${event.kind} — ${truncate(event.detail)}` : event.kind,
      isEvent: true,
      kind: event.kind,
    })),
  ];
  rows.sort((a, b) => b.at.localeCompare(a.at));
  renderRows(rows.slice(0, MAX_ROWS));
}

// ---------------------------------------------------------------------------
// LLM settings
// ---------------------------------------------------------------------------

function llmInputs(): { baseUrl: string; model: string } | null {
  const baseUrl = el<HTMLInputElement>('llm-baseurl').value.trim();
  const model = el<HTMLInputElement>('llm-model').value.trim();
  if (!baseUrl || !model) {
    el('llm-status').textContent = 'Enter both a base URL and a model.';
    return null;
  }
  return { baseUrl, model };
}

async function onLlmSave(): Promise<void> {
  const config = llmInputs();
  if (!config) return;
  await saveLlmConfig(config);
  llmClient = createLlmClient(config);
  if (runActive()) {
    el('llm-status').textContent = 'Saved — applies once the current run ends.';
  } else {
    buildController();
    el('llm-status').textContent = 'Saved and active.';
  }
}

async function onLlmTest(): Promise<void> {
  const config = llmInputs();
  if (!config) return;
  el('llm-status').textContent = 'Testing…';
  const reachable = await createLlmClient(config).available();
  el('llm-status').textContent = reachable ? 'Reachable ✓' : 'Unreachable ✗';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function updateDateMode(): void {
  const mode = el<HTMLSelectElement>('date-mode').value;
  el('date-olderThan').hidden = mode !== 'olderThan';
  el('date-range').hidden = mode !== 'range';
}

function wireEvents(): void {
  for (const id of ['cat-posts', 'cat-reposts', 'cat-replies', 'cat-likes']) {
    el(id).addEventListener('change', render);
  }
  el('date-mode').addEventListener('change', () => {
    updateDateMode();
    render();
  });

  el('btn-delete').addEventListener('click', () => void onDelete());
  el('btn-stop').addEventListener('click', onStop);
  el('btn-resume').addEventListener('click', () => void onResume());

  el('llm-save').addEventListener('click', () => void onLlmSave());
  el('llm-test').addEventListener('click', () => void onLlmTest());

  // The panel outlives tab switches; keep the target-tab warning honest.
  const retarget = () => void resolveActiveTab().then(render);
  browser.tabs.onActivated.addListener(retarget);
  browser.tabs.onUpdated.addListener(retarget);
}

async function init(): Promise<void> {
  el('app').innerHTML = TEMPLATE;
  wireEvents();
  updateDateMode();

  const llmConfig = await loadLlmConfig();
  if (llmConfig) {
    llmClient = createLlmClient(llmConfig);
    el<HTMLInputElement>('llm-baseurl').value = llmConfig.baseUrl;
    el<HTMLInputElement>('llm-model').value = llmConfig.model;
  }
  buildController();

  await resolveActiveTab();
  displayRunId = await log.latestIncompleteRun();
  hasIncompleteRun = displayRunId !== null;

  render();
  await refreshLog();

  // Deletion appends are fire-and-forget inside the controller, so the list
  // catches up on a poll rather than on the status notification alone.
  setInterval(() => {
    if (status.state === 'running') void refreshLog();
  }, POLL_MS);
}

void init();
