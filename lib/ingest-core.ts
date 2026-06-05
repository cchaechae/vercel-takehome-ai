/** Pure parsing/chunking for the ingest pipeline — no fs, no fetch, so it is unit-testable. */
import type { Product } from './store';

export const CHUNK_CHARS = 1400;
export const CHUNK_OVERLAP = 180;
export const MAX_CHUNK_CHARS = 2000;
export const MIN_CHUNK_CHARS = 200;

const BREADCRUMB_SEP = ' › ';

const PRODUCT_LABEL: Record<Product, string> = {
  vercel: 'Vercel',
  nextjs: 'Next.js',
  'ai-sdk': 'AI SDK',
};

export function titleFromMarkdown(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m);
  return (h1?.[1] ?? fallback).trim();
}

/** Extract doc links (absolute or relative) on `docHost` under /docs. */
export function parseLinks(markdown: string, docHost: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\((https?:\/\/[^)]+|\/docs\/[^)]+)\)/g)) {
    let raw = m[1];
    if (raw.startsWith('/')) raw = `https://${docHost}${raw}`;
    const url = raw.replace(/\.md$/, '').replace(/#.*$/, '').replace(/\/$/, '');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== docHost) continue;
    if (!u.pathname.startsWith('/docs')) continue;
    if (u.pathname === '/docs' || u.pathname.endsWith('/llms.txt')) continue;
    out.add(url);
  }
  return [...out];
}

/** Paragraph-aware chunking with a small overlap to preserve context across cuts. */
export function chunkText(text: string): string[] {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const block of blocks) {
    if (cur && cur.length + block.length + 2 > CHUNK_CHARS) {
      chunks.push(cur);
      cur = cur.slice(-CHUNK_OVERLAP) + '\n\n' + block;
    } else {
      cur = cur ? cur + '\n\n' + block : block;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/** Strip a leading YAML frontmatter block; return its scalar keys and the body without it. */
export function stripFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Flatten MDX/JSX wrappers in prose. Fenced code blocks are left untouched. */
export function cleanMdx(body: string): string {
  const cleanProse = (s: string) =>
    s
      .replace(/<Snippet\b[^>]*\btext="([^"]*)"[^>]*\/>/g, '$1')
      .replace(/<[A-Z][A-Za-z0-9]*\b[^>]*\/>/g, '')
      .replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*>/g, '')
      .replace(/<\/?(?:div|figure|figcaption|span)\b[^>]*>/g, '');
  return body
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : cleanProse(part)))
    .join('')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface Section {
  path: string[];
  text: string;
}

/** Split a body into sections by ATX headings, ignoring `#` inside fenced code. */
function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ path: [...stack], text });
    buf = [];
  };
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = inFence ? null : line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      flush();
      const level = h[1].length;
      stack = stack.slice(0, level - 1);
      stack[level - 1] = h[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Split prose into blocks on blank lines, keeping fenced code blocks intact. */
function toBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    const b = cur.join('\n').trim();
    if (b) blocks.push(b);
    cur = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      cur.push(line);
    } else if (!inFence && line.trim() === '') {
      flush();
    } else {
      cur.push(line);
    }
  }
  flush();
  return blocks;
}

/** Greedily pack blocks up to MAX_CHUNK_CHARS without splitting inside a block. */
function packBlocks(text: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const b of toBlocks(text)) {
    if (cur && cur.length + b.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Merge any chunk shorter than MIN_CHUNK_CHARS into the previous one. */
function mergeTiny(chunks: string[]): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    if (out.length && c.length < MIN_CHUNK_CHARS) out[out.length - 1] += `\n\n${c}`;
    else out.push(c);
  }
  return out;
}

export interface RawChunk {
  text: string;
}

/**
 * Structure-aware chunking: split on headings, prefix each chunk with a breadcrumb
 * ("Vercel › Page › Section") so chunks are self-contained, size-bound via
 * fence-aware paragraph packing, and emit the page summary as a synthetic lead chunk.
 */
export function chunkMarkdown(
  body: string,
  opts: { product: Product; title: string; summary?: string },
): RawChunk[] {
  const root = PRODUCT_LABEL[opts.product];
  const chunks: string[] = [];

  if (opts.summary?.trim()) {
    chunks.push(`${[root, opts.title].join(BREADCRUMB_SEP)}\n\n${opts.summary.trim()}`);
  }

  for (const sec of splitSections(body)) {
    const segs = sec.path.length ? sec.path : [opts.title];
    const crumb = [root, ...segs].filter(Boolean).join(BREADCRUMB_SEP);
    for (const piece of packBlocks(sec.text)) {
      chunks.push(`${crumb}\n\n${piece}`);
    }
  }

  return mergeTiny(chunks).map((text) => ({ text }));
}
