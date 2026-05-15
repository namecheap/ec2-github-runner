const log = require('./log');

// Run `fn()` with exponential backoff. `fn` returns a Promise. Retries
// on any rejection; does not look at error shape (callers should only
// pass idempotent operations like DELETE /runners/{id} and
// TerminateInstances — re-executing on transient errors is safe).
//
// Defaults: 3 attempts, 2s base delay, doubled each time, capped at
// 10s. Total worst-case wait is 2s + 4s + 8s = 14s.
async function withRetry(step, fn, opts = {}) {
  const attempts = opts.attempts || 3;
  const baseMs = opts.baseMs || 2000;
  const maxMs = opts.maxMs || 10000;

  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts) {
        log.error(`${step}_retry`, {
          attempt: i,
          attempts,
          exhausted: true,
          error: error.name,
          message: error.message,
        });
        throw error;
      }
      const delayMs = Math.min(baseMs * 2 ** (i - 1), maxMs);
      log.warn(`${step}_retry`, {
        attempt: i,
        attempts,
        next_delay_ms: delayMs,
        error: error.name,
        message: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  /* istanbul ignore next — unreachable, for type safety */
  throw lastError;
}

module.exports = {
  withRetry,
};
