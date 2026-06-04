import { describe, expect, it } from 'vitest';
import { parseIndex } from './store';

// Persisted chunk shape (ChunkMeta): no `embedding` — that lives in embeddings.bin.
const validChunkMeta = {
  id: 'vercel:/docs/x#0',
  product: 'vercel',
  path: 'vercel:/docs/x',
  url: 'https://vercel.com/docs/x',
  title: 'X',
  text: 'hello',
};
const validPage = {
  title: 'X',
  url: 'https://vercel.com/docs/x',
  product: 'vercel',
  text: 'hello',
};
const validIndex = {
  dim: 1536,
  chunks: [validChunkMeta],
  pages: { 'vercel:/docs/x': validPage },
};

describe('parseIndex', () => {
  it('accepts a well-formed index', () => {
    const parsed = parseIndex(validIndex);
    expect(parsed.dim).toBe(1536);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.pages['vercel:/docs/x'].title).toBe('X');
  });

  it('rejects an index missing dim', () => {
    const { dim, ...noDim } = validIndex;
    expect(() => parseIndex(noDim)).toThrow();
  });

  it('rejects an unknown product', () => {
    expect(() =>
      parseIndex({ ...validIndex, chunks: [{ ...validChunkMeta, product: 'svelte' }] }),
    ).toThrow();
  });
});
