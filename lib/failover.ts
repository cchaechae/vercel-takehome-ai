import { SYNTHESIS_MODELS } from './models';

interface FailoverOpts {
  /** Defaults to the configured synthesis models. */
  models?: readonly string[];
  /** Return false to stop failover and rethrow (e.g. a stream already emitted content). */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run `fn` against each model in order, returning the first success. On a
 * retryable error it advances to the next model; a non-retryable error rethrows
 * immediately. Throws the last error if every model fails.
 */
export async function withFailover<T>(
  fn: (model: string) => Promise<T>,
  opts: FailoverOpts = {},
): Promise<T> {
  const models = opts.models ?? SYNTHESIS_MODELS;
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastError: unknown;
  for (const model of models) {
    try {
      return await fn(model);
    } catch (err) {
      lastError = err;
      console.warn(`[failover] model ${model} failed:`, err instanceof Error ? err.message : err);
      if (!isRetryable(err)) throw err;
    }
  }
  throw lastError ?? new Error('All models failed');
}
