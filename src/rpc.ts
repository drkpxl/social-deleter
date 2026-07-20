import { browser } from 'wxt/browser';
import type { DomPrimitives, RpcRequest, RpcResponse } from './types';

let nextId = 1;

/** Built content-script bundle, injected on demand when the declarative one is absent. */
const CONTENT_SCRIPT_FILE = '/content-scripts/bluesky.js';

/**
 * Declarative content scripts only inject at page load, so a tab that was already
 * open when the extension was installed (or reloaded) has none. Inject it on
 * demand and let the caller retry once.
 */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    return true;
  } catch {
    return false;
  }
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.method === 'string';
}

export function createRpcClient(tabId: number): DomPrimitives {
  const send = async (request: RpcRequest): Promise<RpcResponse | undefined> =>
    (await browser.tabs.sendMessage(tabId, request)) as RpcResponse | undefined;

  const call = async (method: keyof DomPrimitives, args?: unknown): Promise<unknown> => {
    const request: RpcRequest = { id: nextId++, method, args };
    let response: RpcResponse | undefined;
    let failure = '';
    try {
      response = await send(request);
      if (!response) failure = 'no response from content script';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // No listener on the other end: the script is missing, not the tab. Inject and retry once.
    if (failure) {
      if (!(await injectContentScript(tabId))) {
        throw new Error(`RPC_UNREACHABLE: ${method} on tab ${tabId} — ${failure}`);
      }
      try {
        response = await send({ ...request, id: nextId++ });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`RPC_UNREACHABLE: ${method} on tab ${tabId} — ${message}`);
      }
      if (!response) {
        throw new Error(`RPC_UNREACHABLE: ${method} on tab ${tabId} — no response after injection`);
      }
    }

    if (!response) {
      throw new Error(`RPC_UNREACHABLE: ${method} on tab ${tabId} — no response from content script`);
    }
    if (response.ok) return response.result;
    throw new Error(response.error);
  };

  return new Proxy({} as DomPrimitives, {
    get(_target, prop: string) {
      return (args?: unknown) => call(prop as keyof DomPrimitives, args);
    },
  });
}

export function serveRpc(impl: DomPrimitives): void {
  browser.runtime.onMessage.addListener((message: unknown): Promise<RpcResponse> | undefined => {
    if (!isRpcRequest(message)) return undefined;
    const { id, method } = message;
    const fn = impl[method];
    if (typeof fn !== 'function') {
      return Promise.resolve({ id, ok: false, error: `Unknown RPC method: ${method}` });
    }
    return (fn as (args?: unknown) => Promise<unknown>)
      .call(impl, message.args)
      .then((result): RpcResponse => ({ id, ok: true, result }))
      .catch((err: unknown): RpcResponse => ({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
  });
}
