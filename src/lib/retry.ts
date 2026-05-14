// Tiny retry helper with exponential backoff + jitter. Used by the AI
// message persist path so a transient Postgres blip doesn't lose the
// reply we already sent the buyer.
//
// Defaults: 3 attempts total, base 100ms, factor 2x, +/- 50% jitter.

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  factor?: number;
  jitter?: number; // 0..1
  // If returned, the result is treated as success and returned. If thrown,
  // we retry until attempts are exhausted, then re-throw the last error.
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULTS: Required<Omit<RetryOptions, "shouldRetry">> = {
  attempts: 3,
  baseMs: 100,
  factor: 2,
  jitter: 0.5,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (options.shouldRetry && !options.shouldRetry(err)) {
        throw err;
      }
      if (attempt >= opts.attempts) break;
      const backoff = opts.baseMs * Math.pow(opts.factor, attempt - 1);
      const jitter = backoff * opts.jitter * (Math.random() * 2 - 1);
      await delay(Math.max(0, Math.round(backoff + jitter)));
    }
  }
  throw lastErr;
}
