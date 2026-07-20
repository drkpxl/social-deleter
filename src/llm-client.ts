/**
 * LLM client — fallback-only, two jobs (selector self-healing + state triage).
 * See docs/02-architecture.md "LLM integration (fallback-only, two jobs)".
 *
 * Talks to any OpenAI-compatible chat-completions endpoint (Ollama, LM Studio)
 * over plain `fetch` — no SDK. The LLM is never in the main loop; every path
 * degrades to a safe default (null selector / pause_for_human) so a missing or
 * unreachable endpoint just falls back to pause-and-notify.
 */
import { browser } from 'wxt/browser';
import { messageOf } from './errors';
import type { LlmClient, LlmConfig, TriageAction } from './types';

/** storage.local key holding the single LLM endpoint config. */
const LLM_CONFIG_KEY = 'llmConfig';

/** Chat requests can run a local 7–14B model for a while; give it room. */
/**
 * Measured against a local Ollama 4B model on a ~6KB snapshot: a warm repair
 * lands in ~20s, but a cold start (or a model swap between requests) can exceed
 * 180s. Healing only runs when the alternative is pausing the run, so waiting is
 * strictly better than giving up — hence a far longer cap than a UI would use.
 */
const CHAT_TIMEOUT_MS = 240_000;
/** Reachability probe must be snappy — it gates whether we even try. */
const PROBE_TIMEOUT_MS = 3_000;

/** A pathological model reply is never a real selector; reject early. */
const MAX_SELECTOR_CHARS = 300;

const TRIAGE_ACTIONS: readonly TriageAction[] = [
  'dismiss',
  'backoff',
  'pause_for_human',
  'abort',
];

/** How many times healSelector will ask the model before giving up. */
const MAX_HEAL_ATTEMPTS = 3;

const HEAL_SYSTEM_PROMPT = [
  'You are repairing a broken CSS selector for a browser-automation tool.',
  'You are given a trimmed HTML snapshot of the page, the selector that stopped',
  'matching, and a plain-language description of the element it should target.',
  'Return a replacement CSS selector that a standard `document.querySelector`',
  'would accept and that locates the described element in the snapshot.',
  'Prefer stable attributes: data-testid, role, aria-label, href patterns, and',
  'type. NEVER use generated class names — anything like css-1a2b3c or r-1loqt21',
  'is build output that changes on every deploy and must not appear in your answer.',
  'Reply with ONLY the selector — a single line, no prose, no explanation,',
  'no code fences, no surrounding quotes.',
].join(' ');

/** Sent after a malformed reply to nudge the model back to the contract. */
const HEAL_CORRECTION_PROMPT = [
  'That reply was not a single valid CSS selector.',
  'Reply again with ONLY one valid CSS selector on a single line —',
  'no prose, no code fences, no quotes.',
].join(' ');

/** Sent after a syntactically fine but useless proposal, so the model doesn't repeat it. */
function rejectedProposalsPrompt(rejected: string[]): string {
  return [
    'These selectors were already tried and matched NOTHING on the live page:',
    ...rejected.map((selector) => `- ${selector}`),
    'Propose a DIFFERENT selector. Anchor it on a stable attribute you can see in',
    'the snapshot (data-testid, role, aria-label, href), never on generated class',
    'names such as css-* or r-*. Reply with ONLY the selector.',
  ].join('\n');
}

const TRIAGE_SYSTEM_PROMPT = [
  'You classify an unexpected page state for a deletion-automation tool and pick',
  'exactly one recovery action. Reply with ONLY one of these four words, nothing',
  'else:',
  '- dismiss: a benign modal/popup/toast that can simply be closed.',
  '- backoff: a rate-limit or transient error; wait and retry.',
  '- pause_for_human: a captcha, login/logged-out wall, or anything that needs a human.',
  '- abort: an unrecoverable state.',
].join('\n');

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Trim a trailing slash so `${baseUrl}/chat/completions` never doubles up. */
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export interface LlmProbe {
  ok: boolean;
  status?: number;
  /** Actionable message when the server is up but refusing us. */
  hint?: string;
}

/**
 * Send the smallest possible completion to prove the endpoint will actually
 * answer requests from this extension. Doubles as a model preload.
 */
export async function probeChat(config: LlmConfig, timeoutMs = CHAT_TIMEOUT_MS): Promise<LlmProbe> {
  try {
    const res = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status };
    // 403 from a reachable server is nearly always an origin allowlist: Ollama
    // and LM Studio both refuse cross-origin POSTs until configured.
    const hint =
      res.status === 403
        ? 'The server refused this extension (403). Ollama: restart it with OLLAMA_ORIGINS="chrome-extension://*". LM Studio: enable CORS in its server settings.'
        : `The server answered ${res.status}. Check the model name is exactly one the server has loaded.`;
    return { ok: false, status: res.status, hint };
  } catch (err) {
    return { ok: false, hint: `Could not reach ${config.baseUrl} — ${messageOf(err)}` };
  }
}

/**
 * POST a chat-completions request and return the assistant text. Throws on
 * timeout, network error, non-2xx, or a response missing the message content —
 * callers map those to their own safe defaults.
 */
async function chatCompletion(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const res = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, temperature: 0, messages }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`chat/completions returned HTTP ${res.status}`);

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('chat/completions response had no text content');
  return content;
}

/**
 * Syntax-only validity check. Live-DOM matching is the caller's job; here we
 * only reject selectors the parser can't even accept. `document` is absent in
 * some worker contexts, where we cannot disprove validity — accept and let the
 * caller's live-DOM check catch a bad selector.
 */
function isValidSelectorSyntax(selector: string): boolean {
  if (typeof document === 'undefined') return true;
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a plausible CSS selector out of a raw model reply: strip code fences,
 * take the first non-empty line, drop wrapping quotes/backticks. Returns null
 * when the result is empty, implausibly long, or syntactically invalid.
 */
function parseSelector(raw: string): string | null {
  const withoutFences = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const firstLine =
    withoutFences
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const selector = firstLine.replace(/^['"`]+|['"`]+$/g, '').trim();

  if (!selector || selector.length > MAX_SELECTOR_CHARS) return null;
  if (!isValidSelectorSyntax(selector)) return null;
  return selector;
}

/** Strict enum parse: normalize, then match a bare action word. Else null. */
function parseTriageAction(raw: string): TriageAction | null {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const normalized = firstLine.toLowerCase().replace(/[^a-z_]/g, '');
  return TRIAGE_ACTIONS.includes(normalized as TriageAction)
    ? (normalized as TriageAction)
    : null;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  return {
    /**
     * Probe the capability we actually need — a chat completion — not just that
     * the server answers. Ollama happily serves GET /models to any origin while
     * rejecting POST /chat/completions with 403 unless OLLAMA_ORIGINS allows the
     * extension, so a GET probe reports "reachable" for a server that can never
     * heal anything.
     */
    async available(): Promise<boolean> {
      return (await probeChat(config)).ok;
    },

    /**
     * Send a trivial completion so the server loads the model into memory. A
     * cold first heal can take minutes while the model loads; doing it up front
     * (from the settings "Test" button) keeps the first real repair fast.
     */
    async warmUp(): Promise<boolean> {
      try {
        const res = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ok' }],
          }),
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    async healSelector(args): Promise<string | null> {
      const rejected = args.rejected ?? [];
      const userMessage = [
        `Intent: ${args.intent}`,
        `Broken selector: ${args.failedSelector}`,
        'HTML snapshot:',
        args.snapshotHtml,
      ].join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: HEAL_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ];
      // Proposals the caller already validated against the live DOM and rejected.
      if (rejected.length > 0) {
        messages.push({ role: 'user', content: rejectedProposalsPrompt(rejected) });
      }

      // Corrective retries on malformed output; any request failure ends it.
      for (let attempt = 0; attempt < MAX_HEAL_ATTEMPTS; attempt++) {
        let reply: string;
        try {
          reply = await chatCompletion(config, messages);
        } catch {
          return null;
        }
        const selector = parseSelector(reply);
        // A repeat of something the live DOM already refused is not progress.
        if (selector && !rejected.includes(selector)) return selector;
        messages.push({ role: 'assistant', content: reply });
        messages.push({
          role: 'user',
          content: selector ? rejectedProposalsPrompt([...rejected, selector]) : HEAL_CORRECTION_PROMPT,
        });
      }
      return null;
    },

    async triageState(args): Promise<TriageAction> {
      const messages: ChatMessage[] = [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        { role: 'user', content: args.pageText },
      ];
      try {
        const reply = await chatCompletion(config, messages);
        // pause_for_human is the safe default for anything unparseable.
        return parseTriageAction(reply) ?? 'pause_for_human';
      } catch {
        return 'pause_for_human';
      }
    },
  };
}

export async function loadLlmConfig(): Promise<LlmConfig | null> {
  const stored = await browser.storage.local.get(LLM_CONFIG_KEY);
  return (stored[LLM_CONFIG_KEY] as LlmConfig | undefined) ?? null;
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await browser.storage.local.set({ [LLM_CONFIG_KEY]: config });
}
