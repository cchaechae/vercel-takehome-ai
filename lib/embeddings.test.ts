import { describe, expect, it } from 'vitest';
import { isRateLimit } from './embeddings';

describe('isRateLimit', () => {
  it('detects 429 on the top-level status code', () => {
    expect(isRateLimit({ statusCode: 429 })).toBe(true);
  });
  it('detects 429 nested under cause', () => {
    expect(isRateLimit({ cause: { statusCode: 429 } })).toBe(true);
  });
  it('detects rate-limit wording in the message', () => {
    expect(isRateLimit({ message: 'Rate limit exceeded on free tier' })).toBe(true);
    expect(isRateLimit({ message: 'got a 429 back' })).toBe(true);
  });
  it('returns false for unrelated errors', () => {
    expect(isRateLimit({ statusCode: 500 })).toBe(false);
    expect(isRateLimit(new Error('boom'))).toBe(false);
  });
});
