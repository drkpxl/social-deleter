/** Shared error helpers — one spelling of the unknown→string narrowing. */

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load-bearing protocol string: rpc.ts stamps it onto every "the content script
 * isn't there" error and the RunController detects it to pause with tab-gone.
 */
export const RPC_UNREACHABLE_PREFIX = 'RPC_UNREACHABLE:';
