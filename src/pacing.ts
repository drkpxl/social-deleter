import type { PacingProfile } from './types';

/** Bluesky is the friendliest target — modest human-like pacing, patient backoff. */
export const DEFAULT_BLUESKY_PACING: PacingProfile = {
  minDelayMs: 1200,
  maxDelayMs: 3500,
  backoffBaseMs: 5_000,
  backoffFactor: 2,
  backoffMaxMs: 5 * 60 * 1000,
};

/** Named so callers (and Stop handling) can distinguish an aborted sleep from a real failure. */
export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Randomized action delays + exponential backoff for one run.
 *
 * Abort model: a signal may be supplied at construction (applies to every
 * sleep) and/or per call (takes precedence for that call). When the signal
 * fires, the pending sleep rejects with an AbortError so Stop never waits out
 * a delay.
 */
export class PacingEngine {
  private attempt = 0;

  constructor(
    private readonly profile: PacingProfile,
    private readonly signal?: AbortSignal,
  ) {}

  /** Random delay uniform in [minDelayMs, maxDelayMs]. */
  delay(signal?: AbortSignal): Promise<void> {
    const { minDelayMs, maxDelayMs } = this.profile;
    const ms = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    return this.sleep(ms, signal);
  }

  /** Exponential backoff: base * factor^attempt capped at max, ±20% jitter. Increments the attempt counter. */
  backoff(signal?: AbortSignal): Promise<void> {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.profile;
    const capped = Math.min(backoffBaseMs * backoffFactor ** this.attempt, backoffMaxMs);
    const jitter = capped * (Math.random() * 0.4 - 0.2); // ±20%
    this.attempt++;
    return this.sleep(capped + jitter, signal);
  }

  /** Clear the backoff attempt counter after a successful action. */
  resetBackoff(): void {
    this.attempt = 0;
  }

  private sleep(ms: number, perCall?: AbortSignal): Promise<void> {
    const signal = perCall ?? this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
