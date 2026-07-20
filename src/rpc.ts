import { browser } from 'wxt/browser';
import type { DomPrimitives, RpcRequest, RpcResponse } from './types';

let nextId = 1;

function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.method === 'string';
}

export function createRpcClient(tabId: number): DomPrimitives {
  const call = async (method: keyof DomPrimitives, args?: unknown): Promise<unknown> => {
    const request: RpcRequest = { id: nextId++, method, args };
    let response: RpcResponse | undefined;
    try {
      response = (await browser.tabs.sendMessage(tabId, request)) as RpcResponse | undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`RPC_UNREACHABLE: ${method} on tab ${tabId} — ${message}`);
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
