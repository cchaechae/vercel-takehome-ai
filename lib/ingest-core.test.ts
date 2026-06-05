import { describe, expect, it } from 'vitest';
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  MIN_CHUNK_CHARS,
  chunkMarkdown,
  chunkText,
  cleanMdx,
  parseLinks,
  stripFrontmatter,
  titleFromMarkdown,
} from './ingest-core';

const crumbOf = (text: string) => text.split('\n\n')[0];

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

describe('stripFrontmatter', () => {
  it('extracts scalar keys and returns the body without the block', () => {
    const md = [
      '---',
      'title: AI Gateway',
      'product: vercel',
      'summary: Does X and Y.',
      'prerequisites:',
      '  []',
      '---',
      '',
      '# AI Gateway',
      '',
      'body',
    ].join('\n');
    const { meta, body } = stripFrontmatter(md);
    expect(meta.title).toBe('AI Gateway');
    expect(meta.summary).toBe('Does X and Y.');
    expect(meta.prerequisites).toBeUndefined(); // empty value skipped
    expect(body).not.toContain('---');
    expect(body).toContain('# AI Gateway');
  });

  it('passes through when there is no frontmatter', () => {
    const r = stripFrontmatter('# Just a doc\n\ntext');
    expect(r.meta).toEqual({});
    expect(r.body).toBe('# Just a doc\n\ntext');
  });
});

describe('cleanMdx', () => {
  it('drops layout wrappers and unwraps components, keeping inner text', () => {
    expect(cleanMdx('<div className="x">\nhello\n</div>')).toBe('hello');
    expect(cleanMdx('<Note>\nbe careful\n</Note>')).toContain('be careful');
    expect(cleanMdx('<Snippet text="npm i ai" dark />')).toBe('npm i ai');
  });

  it('preserves JSX/HTML inside fenced code blocks', () => {
    const withCode = '```tsx\n<div>keep me</div>\n```';
    expect(cleanMdx(withCode)).toContain('<div>keep me</div>');
  });
});

describe('chunkMarkdown', () => {
  it('prefixes every chunk with a product › page › section breadcrumb', () => {
    // Sections are sized above MIN_CHUNK_CHARS so they stay distinct chunks.
    const md = `# Page\n\n${'intro '.repeat(50)}\n\n## Config\n\n${'config '.repeat(50)}`;
    const chunks = chunkMarkdown(md, { product: 'nextjs', title: 'Page' });
    const crumbs = chunks.map((c) => crumbOf(c.text));
    expect(crumbs).toContain('Next.js › Page');
    expect(crumbs).toContain('Next.js › Page › Config');
    expect(chunks.every((c) => c.text.startsWith('Next.js › Page'))).toBe(true);
  });

  it('does not treat `#` inside a code fence as a heading', () => {
    const md = ['# Title', '', '## Real', '', '```bash', '# not a heading', '', 'still code', '```'].join('\n');
    const chunks = chunkMarkdown(md, { product: 'vercel', title: 'Title' });
    expect(chunks.some((c) => c.text.includes('# not a heading'))).toBe(true); // kept as code
    expect(chunks.every((c) => !crumbOf(c.text).includes('not a heading'))).toBe(true); // not a section
  });

  it('emits the summary as a synthetic lead chunk', () => {
    const chunks = chunkMarkdown(`# P\n\n${'body '.repeat(60)}`, {
      product: 'vercel',
      title: 'P',
      summary: 'A short summary.',
    });
    expect(chunks[0].text).toBe('Vercel › P\n\nA short summary.');
  });

  it('falls back to the page breadcrumb on a flat page (no headings)', () => {
    const chunks = chunkMarkdown('just some text\n\nmore text', { product: 'ai-sdk', title: 'Flat' });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((c) => c.text.startsWith('AI SDK › Flat'))).toBe(true);
  });

  it('sub-splits an oversized section but keeps the breadcrumb on each piece', () => {
    const para = 'y'.repeat(800);
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}`; // ~2.4k > MAX_CHUNK_CHARS
    const chunks = chunkMarkdown(md, { product: 'vercel', title: 'Big' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.startsWith('Vercel › Big'))).toBe(true);
  });

  it('merges a tiny section into the previous chunk', () => {
    const md = `# A\n\n${'z'.repeat(300)}\n\n## Tiny\n\nx`;
    const chunks = chunkMarkdown(md, { product: 'vercel', title: 'A' });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('Tiny');
    expect(chunks[0].text.length).toBeGreaterThan(MIN_CHUNK_CHARS);
  });
});
