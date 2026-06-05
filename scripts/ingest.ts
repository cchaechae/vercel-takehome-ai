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
import { chunkMarkdown, cleanMdx, parseLinks, stripFrontmatter, titleFromMarkdown } from '../lib/ingest-core';
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

/** Collect doc URLs from llms.txt; if the index is thin, crawl one level deeper. */
async function collectUrls(src: Source): Promise<string[]> {
  const indexMd = await getText(src.indexUrl);
  // Curated seeds first so they survive the cap; then llms.txt-derived links.
  const seen = new Set([...(src.seeds ?? []), ...parseLinks(indexMd, src.docHost)]);

  if (seen.size < MAX_PAGES_PER_PRODUCT) {
    for (const seed of [...seen]) {
      if (seen.size >= MAX_PAGES_PER_PRODUCT) break;
      try {
        for (const link of parseLinks(await getMarkdown(seed), src.docHost)) seen.add(link);
      } catch {
        /* skip unreachable seed */
      }
    }
  }
  return [...seen].slice(0, MAX_PAGES_PER_PRODUCT);
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
      const raw = await getMarkdown(url);
      const { meta, body } = stripFrontmatter(raw);
      const clean = cleanMdx(body);
      const title = meta.title ?? titleFromMarkdown(clean, pathname.split('/').pop() ?? pathname);
      pages.push({ title, url, product: src.product, text: clean });
      chunkMarkdown(clean, { product: src.product, title, summary: meta.summary }).forEach((c, i) => {
        pending.push({ id: `${pathKey}#${i}`, product: src.product, path: pathKey, url, title, text: c.text });
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
