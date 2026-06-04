/**
 * Ingest pipeline (run once, offline): build the RAG corpus from the official
 * `llms.txt` indexes of Vercel, Next.js, and the AI SDK.
 *
 *   llms.txt (index of doc links)  ->  fetch each page as markdown
 *   ->  chunk  ->  embed  ->  data/docs-index.json
 *
 * The committed JSON makes the deploy self-contained: no scraping at runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { embedBatch } from '../lib/embeddings';
import type { Chunk, DocsIndex, Page, Product } from '../lib/store';

interface Source {
  product: Product;
  indexUrl: string;
  docHost: string; // only keep links on this host under /docs
  seeds?: string[]; // must-have pages, always included (the llms.txt index is huge and gets capped)
}

const SOURCES: Source[] = [
  {
    product: 'vercel',
    indexUrl: 'https://vercel.com/llms.txt',
    docHost: 'vercel.com',
    seeds: [
      'https://vercel.com/docs/ai-gateway',
      'https://vercel.com/docs/ai',
      'https://vercel.com/docs/functions',
      'https://vercel.com/docs/functions/fluid-compute',
      'https://vercel.com/docs/edge-network/caching',
      'https://vercel.com/docs/edge-network',
      'https://vercel.com/docs/cron-jobs',
      'https://vercel.com/docs/deployments',
      'https://vercel.com/docs/environment-variables',
    ],
  },
  { product: 'nextjs', indexUrl: 'https://nextjs.org/docs/llms.txt', docHost: 'nextjs.org' },
  { product: 'ai-sdk', indexUrl: 'https://ai-sdk.dev/llms.txt', docHost: 'ai-sdk.dev' },
];

const MAX_PAGES_PER_PRODUCT = 35;
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 180;
const EMBED_BATCH = 64;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mdCache = new Map<string, string>();

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/** Fetch the markdown (.md) form of a doc page, cached. */
async function getMarkdown(docUrl: string): Promise<string> {
  const mdUrl = `${docUrl}.md`;
  const cached = mdCache.get(mdUrl);
  if (cached) return cached;
  const md = await getText(mdUrl);
  mdCache.set(mdUrl, md);
  return md;
}

/** Extract doc links (absolute or relative) on the source host under /docs. */
function parseLinks(markdown: string, src: Source): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\((https?:\/\/[^)]+|\/docs\/[^)]+)\)/g)) {
    let raw = m[1];
    if (raw.startsWith('/')) raw = `https://${src.docHost}${raw}`;
    const url = raw.replace(/\.md$/, '').replace(/#.*$/, '').replace(/\/$/, '');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== src.docHost) continue;
    if (!u.pathname.startsWith('/docs')) continue;
    if (u.pathname === '/docs' || u.pathname.endsWith('/llms.txt')) continue;
    out.add(url);
  }
  return [...out];
}

/** Collect doc URLs from llms.txt; if the index is thin, crawl one level deeper. */
async function collectUrls(src: Source): Promise<string[]> {
  const indexMd = await getText(src.indexUrl);
  // Curated seeds first so they survive the cap; then llms.txt-derived links.
  const seen = new Set([...(src.seeds ?? []), ...parseLinks(indexMd, src)]);

  if (seen.size < MAX_PAGES_PER_PRODUCT) {
    for (const seed of [...seen]) {
      if (seen.size >= MAX_PAGES_PER_PRODUCT) break;
      try {
        for (const link of parseLinks(await getMarkdown(seed), src)) seen.add(link);
      } catch {
        /* skip unreachable seed */
      }
    }
  }
  return [...seen].slice(0, MAX_PAGES_PER_PRODUCT);
}

function titleFromMarkdown(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+)$/m);
  return (h1?.[1] ?? fallback).trim();
}

/** Paragraph-aware chunking with a small overlap to preserve context across cuts. */
function chunkText(text: string): string[] {
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

async function ingestSource(src: Source): Promise<{ pages: Page[]; pending: Omit<Chunk, 'embedding'>[] }> {
  console.log(`\n[${src.product}] reading index ${src.indexUrl}`);
  const urls = await collectUrls(src);
  console.log(`[${src.product}] ${urls.length} doc pages`);

  const pages: Page[] = [];
  const pending: Omit<Chunk, 'embedding'>[] = [];

  for (const url of urls) {
    const pathname = new URL(url).pathname;
    const pathKey = `${src.product}:${pathname}`;
    try {
      const md = await getMarkdown(url);
      const title = titleFromMarkdown(md, pathname.split('/').pop() ?? pathname);
      pages.push({ title, url, product: src.product, text: md });
      chunkText(md).forEach((text, i) => {
        pending.push({ id: `${pathKey}#${i}`, product: src.product, path: pathKey, url, title, text });
      });
    } catch (err) {
      console.warn(`[${src.product}] skip ${url}: ${(err as Error).message}`);
    }
  }
  return { pages, pending };
}

async function main() {
  const allPending: Omit<Chunk, 'embedding'>[] = [];
  const pageMap: Record<string, Page> = {};

  for (const src of SOURCES) {
    const { pages, pending } = await ingestSource(src);
    for (const p of pages) pageMap[`${p.product}:${new URL(p.url).pathname}`] = p;
    allPending.push(...pending);
  }

  console.log(`\nEmbedding ${allPending.length} chunks...`);
  const embeddings: number[][] = [];
  for (let i = 0; i < allPending.length; i += EMBED_BATCH) {
    const batch = allPending.slice(i, i + EMBED_BATCH);
    embeddings.push(...(await embedBatch(batch.map((c) => c.text))));
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, allPending.length)}/${allPending.length}`);
    if (i + EMBED_BATCH < allPending.length) await sleep(3000); // be gentle on free tier
  }

  const dim = embeddings[0]?.length ?? 0;
  const index: DocsIndex = { dim, chunks: allPending, pages: pageMap };
  const flat = new Float32Array(allPending.length * dim);
  embeddings.forEach((e, i) => flat.set(e, i * dim));

  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, 'docs-index.json');
  const binFile = path.join(outDir, 'embeddings.bin');
  fs.writeFileSync(jsonFile, JSON.stringify(index));
  fs.writeFileSync(binFile, Buffer.from(flat.buffer));

  const mb = (f: string) => (fs.statSync(f).size / 1e6).toFixed(1);
  console.log(
    `\nWrote ${allPending.length} chunks, ${Object.keys(pageMap).length} pages, dim ${dim}\n` +
      `  ${jsonFile} (${mb(jsonFile)} MB) + ${binFile} (${mb(binFile)} MB)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
