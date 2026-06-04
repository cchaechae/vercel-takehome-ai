import { describe, expect, it, vi } from 'vitest';
import { withFailover } from './failover';

describe('withFailover', () => {
  it('returns the first success and stops', async () => {
    const run = vi.fn(async (model: string) => model);
    const result = await withFailover(run, { models: ['a', 'b'] });
    expect(result).toBe('a');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls over to the next model on a retryable error', async () => {
    const run = vi
      .fn<(m: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('a down'))
      .mockResolvedValueOnce('b');
    const result = await withFailover(run, { models: ['a', 'b'] });
    expect(result).toBe('b');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on a non-retryable error', async () => {
    const fatal = new Error('content already streamed');
    const run = vi.fn(async () => {
      throw fatal;
    });
    await expect(
      withFailover(run, { models: ['a', 'b'], isRetryable: () => false }),
    ).rejects.toBe(fatal);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when every model fails', async () => {
    const run = vi
      .fn<(m: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b last'));
    await expect(withFailover(run, { models: ['a', 'b'] })).rejects.toThrow('b last');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('throws when the models list is empty', async () => {
    const run = vi.fn(async () => 'ok');
    await expect(withFailover(run, { models: [] })).rejects.toThrow('All models failed');
    expect(run).not.toHaveBeenCalled();
  });
});
