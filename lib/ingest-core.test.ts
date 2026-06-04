import { describe, expect, it } from 'vitest';
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkText,
  parseLinks,
  titleFromMarkdown,
} from './ingest-core';

describe('titleFromMarkdown', () => {
  it('reads the first H1', () => {
    expect(titleFromMarkdown('# Hello\n\nbody', 'fb')).toBe('Hello');
  });
  it('falls back when there is no H1', () => {
    expect(titleFromMarkdown('no heading here', 'fallback')).toBe('fallback');
  });
});

describe('parseLinks', () => {
  const md = [
    '[A](https://nextjs.org/docs/app/foo.md)',
    '[B](/docs/app/bar#frag)',
    '[C](https://other.com/docs/x)',
    '[D](https://nextjs.org/blog/post)',
    '[E](https://nextjs.org/docs/app/foo)',
  ].join('\n');

  it('keeps on-host /docs links, resolves relative, strips .md/#, dedupes', () => {
    expect(parseLinks(md, 'nextjs.org')).toEqual([
      'https://nextjs.org/docs/app/foo',
      'https://nextjs.org/docs/app/bar',
    ]);
  });

  it('excludes the /docs root and any /llms.txt path', () => {
    const md = [
      '[X](https://nextjs.org/docs)',
      '[Y](https://nextjs.org/docs/llms.txt)',
      '[Z](https://nextjs.org/docs/nested/llms.txt)',
    ].join('\n');
    expect(parseLinks(md, 'nextjs.org')).toEqual([]);
  });

  it('skips malformed URLs without throwing', () => {
    expect(() => parseLinks('[bad](not a url)', 'nextjs.org')).not.toThrow();
    expect(parseLinks('[bad](not a url)', 'nextjs.org')).toEqual([]);
  });
});

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps small paragraphs in one chunk', () => {
    expect(chunkText('para one\n\npara two')).toEqual(['para one\n\npara two']);
  });

  it('splits past the size limit and carries overlap into the next chunk', () => {
    const big = 'a'.repeat(CHUNK_CHARS - 10);
    const tail = 'b'.repeat(100);
    const chunks = chunkText(`${big}\n\n${tail}`);

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(big);
    expect(chunks[1].startsWith('a'.repeat(CHUNK_OVERLAP))).toBe(true);
    expect(chunks[1]).toContain(tail);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });
});
