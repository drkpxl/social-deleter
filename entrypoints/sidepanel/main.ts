/**
 * Side-panel UI (roadmap task 9) — the panel is the orchestrator host: it owns
 * the RunController and every long-lived module. Plain DOM, no framework.
 *
 * Safety posture (docs/02-architecture.md "Control flow and safety posture"):
 * Delete starts immediately — no confirmation dialog, no dry-run.
 */
import './style.css';
import { siteForUrl, SITES, type SiteRegistration } from '@/src/adapters';
import { DeletionLog } from '@/src/deletion-log';
import { createLlmClient, loadLlmConfig, probeChat, saveLlmConfig } from '@/src/llm-client';
import { RunController } from '@/src/run-controller';
import { newRunId } from '@/src/run-id';
import { collectDiagnostics } from '@/src/diagnostics';
import type {
  Category,
  DateFilter,
  LlmClient,
  RunConfig,
  RunEvent,
  RunStatus,
  Site,
} from '@/src/types';

/** Sites the panel can drive, for the "open one of these" hint. */
const SITE_LABELS = SITES.map((s) => s.label).join(' or ');
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
    <label id="lbl-posts"><input type="checkbox" id="cat-posts" checked /> Posts</label>
    <label id="lbl-reposts"><input type="checkbox" id="cat-reposts" checked /> Reposts</label>
    <label id="lbl-replies"><input type="checkbox" id="cat-replies" checked /> Replies</label>
    <label id="lbl-likes"><input type="checkbox" id="cat-likes" checked /> Likes</label>
    <p id="cat-note" class="hint"></p>
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

  <details class="llm">
    <summary>Diagnostics</summary>
    <small>Dumps what each selector matches on this page, plus a real DOM sample — paste it into a bug report when something finds nothing.</small>
    <div class="llm-actions">
      <button type="button" id="btn-diagnose" class="btn">Copy selector report</button>
    </div>
    <p id="diag-status" class="hint"></p>
  </details>
`;

interface ActiveTab {
  id: number;
  url: string;
  /** The registry row for this tab's host; absent = a site we don't drive. */
  registration?: SiteRegistration;
}

/** Every category the UI can show, and the checkbox/label ids that carry it. */
const CATEGORY_ORDER: Category[] = ['posts', 'reposts', 'replies', 'likes'];

/** Why a category is missing on a given site — shown instead of a silent absence. */
const CATEGORY_ABSENT_HINT: Partial<Record<Site, Partial<Record<Category, string>>>> = {
  threads: { likes: 'Threads doesn’t list your liked posts, so they can’t be deleted here.' },
};

interface LogRow {
  at: string;
  text: string;
  isEvent: boolean;
  kind?: RunEvent['kind'];
}

const log = new DeletionLog();

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
    // Resolved at run time from the registry, so the controller always builds the
    // adapter for whatever site the pinned tab is on. No `pacing` override is
    // passed: each adapter's own profile must win (Threads runs far slower).
    adapterFactory: (tabId) => {
      const registration = activeTab?.registration;
      if (!registration) throw new Error('No supported site is open in the active tab');
      return registration.factory(tabId);
    },
    log,
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

/** Categories the active site offers; everything else is hidden, never silently ignored. */
function availableCategories(): Category[] {
  return activeTab?.registration?.categories ?? CATEGORY_ORDER;
}

function selectedCategories(): Category[] {
  const available = availableCategories();
  return CATEGORY_ORDER.filter(
    (cat) => available.includes(cat) && el<HTMLInputElement>(`cat-${cat}`).checked,
  );
}

/**
 * On Bluesky likes render no timestamps and reposts show the original post's
 * date, not the repost's — a run made only of such categories cannot be
 * date-filtered. Which categories those are is per-site registry data.
 */
function dateFilterUnavailable(cats: Category[]): boolean {
  const supports = activeTab?.registration?.supportsDateFilter;
  if (!supports) return false;
  return cats.length > 0 && !cats.some((cat) => supports[cat]);
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
  const registration = siteForUrl(url);
  activeTab = registration ? { id: tab.id, url, registration } : { id: tab.id, url };
}

function tabSupported(): boolean {
  return activeTab?.registration !== undefined;
}

/** The run is pinned to whichever tab is active at click time. */
function baseConfig(tab: ActiveTab & { registration: SiteRegistration }): Omit<RunConfig, 'runId'> {
  return {
    site: tab.registration.site,
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
  const tab = activeTab;
  if (!tab?.registration || selectedCategories().length === 0) return;

  const config: RunConfig = {
    ...baseConfig({ ...tab, registration: tab.registration }),
    runId: newRunId(),
  };
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
  const tab = activeTab;
  if (!tab?.registration || selectedCategories().length === 0) return;
  // resume() reuses the latest incomplete runId and rebuilds the skip-set from the log.
  launch(controller.resume(baseConfig({ ...tab, registration: tab.registration })));
}

/** Dump what the shipped selectors actually match here, for pasting into a bug report. */
async function onDiagnose(): Promise<void> {
  const note = el('diag-status');
  await resolveActiveTab();
  const registration = activeTab?.registration;
  if (!activeTab || !registration) {
    note.textContent = `Open your ${SITE_LABELS} profile tab first.`;
    return;
  }
  note.textContent = 'Collecting…';
  try {
    const report = await collectDiagnostics(activeTab.id, registration.site);
    console.log(report);
    try {
      await navigator.clipboard.writeText(report);
      note.textContent = 'Copied to clipboard (also logged to this panel’s console).';
    } catch {
      // Clipboard needs focus/permission; the console copy is always available.
      note.textContent = 'Logged to this panel’s console — right-click the panel → Inspect to copy.';
    }
  } catch (err) {
    note.textContent = `Diagnostics failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTabStatus(): void {
  const node = el('tab-status');
  if (!activeTab) {
    node.textContent = 'No active tab detected.';
    node.className = 'tab-status warn';
  } else if (!activeTab.registration) {
    node.textContent = `Active tab isn’t a supported site — open ${SITE_LABELS} in this window to run.`;
    node.className = 'tab-status warn';
  } else {
    node.textContent = `Ready on ${activeTab.registration.label}`;
    node.className = 'tab-status ok';
  }
}

/** Hide the categories this site can't offer, and say why rather than just dropping them. */
function renderCategories(): void {
  const registration = activeTab?.registration;
  const available = availableCategories();
  const notes: string[] = [];

  for (const cat of CATEGORY_ORDER) {
    const supported = available.includes(cat);
    el(`lbl-${cat}`).hidden = !supported;
    // Also uncheck it: a hidden-but-checked box would silently widen the run.
    if (!supported) el<HTMLInputElement>(`cat-${cat}`).checked = false;
    const hint = supported ? undefined : registration && CATEGORY_ABSENT_HINT[registration.site]?.[cat];
    if (hint) notes.push(hint);
  }
  el('cat-note').textContent = notes.join(' ');
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
  renderTabStatus();
  renderCategories();

  const cats = selectedCategories();
  const running = runActive();
  const noDates = dateFilterUnavailable(cats);
  const usable = tabSupported() && cats.length > 0;

  el<HTMLFieldSetElement>('categories').disabled = running;
  el<HTMLFieldSetElement>('datefilter').disabled = running || noDates;
  el('date-note').textContent = noDates
    ? 'The selected categories carry no usable date on this site — date filter unavailable.'
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
  const note = el('llm-status');
  // Probes a real completion, not just that the server is up — and it doubles as
  // a model preload, so the first repair doesn't pay a cold start.
  note.textContent = 'Testing (loading the model may take a minute)…';
  const probe = await probeChat(config);
  note.textContent = probe.ok ? 'Ready ✓ — model answered and is loaded' : `Not usable ✗ — ${probe.hint ?? 'unknown error'}`;
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
  for (const cat of CATEGORY_ORDER) {
    el(`cat-${cat}`).addEventListener('change', render);
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
  el('btn-diagnose').addEventListener('click', () => void onDiagnose());

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
