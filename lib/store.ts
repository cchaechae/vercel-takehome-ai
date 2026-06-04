import fs from 'node:fs';
import path from 'node:path';
import { cosineSimilarity } from 'ai';
import { embedQuery } from './embeddings';
import { z } from 'zod';

export type Product = 'vercel' | 'nextjs' | 'ai-sdk';

export interface Chunk {
  id: string;
  product: Product;
  path: string; // stable key, e.g. "vercel:/docs/fundamentals/builds"
  url: string;
  title: string;
  text: string;
  embedding: number[];
}

/** A chunk as persisted in docs-index.json — its vector lives in embeddings.bin. */
export type ChunkMeta = Omit<Chunk, 'embedding'>;

export interface Page {
  title: string;
  url: string;
  product: Product;
  text: string;
}

/** On-disk shape. Vectors are a separate Float32 blob, keyed by chunk order. */
export interface DocsIndex {
  dim: number;
  chunks: ChunkMeta[];
  pages: Record<string, Page>;
}

const ProductSchema = z.enum(['vercel', 'nextjs', 'ai-sdk']);

const ChunkMetaSchema = z.object({
  id: z.string(),
  product: ProductSchema,
  path: z.string(),
  url: z.string(),
  title: z.string(),
  text: z.string(),
});

const PageSchema = z.object({
  title: z.string(),
  url: z.string(),
  product: ProductSchema,
  text: z.string(),
});

const DocsIndexSchema = z.object({
  dim: z.number().int().positive(),
  chunks: z.array(ChunkMetaSchema),
  pages: z.record(z.string(), PageSchema),
});

/** Validate the index JSON at the trust boundary so a corrupt or stale index fails loudly. */
export function parseIndex(raw: unknown): DocsIndex {
  return DocsIndexSchema.parse(raw);
}

interface LoadedIndex {
  chunks: Chunk[];
  pages: Record<string, Page>;
}

let cache: LoadedIndex | null = null;

// Embeddings are stored as a packed Float32 blob (row-major, chunk order) rather
// than JSON numbers: ~5x smaller on disk and no number parsing on the cold-start
// path. float32 is ample precision for cosine ranking.
function load(): LoadedIndex {
  if (cache) return cache;
  const dir = path.join(process.cwd(), 'data');
  const meta = parseIndex(JSON.parse(fs.readFileSync(path.join(dir, 'docs-index.json'), 'utf8')));
  const buf = fs.readFileSync(path.join(dir, 'embeddings.bin'));
  const floats = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { dim } = meta;
  if (floats.length !== meta.chunks.length * dim) {
    throw new Error(
      `embeddings.bin (${floats.length} floats) does not match docs-index.json (${meta.chunks.length} chunks x ${dim} dim). Re-run \`npm run ingest\`.`,
    );
  }
  const chunks: Chunk[] = meta.chunks.map((c, i) => ({
    ...c,
    embedding: Array.from(floats.subarray(i * dim, (i + 1) * dim)),
  }));
  cache = { chunks, pages: meta.pages };
  return cache;
}

export interface SearchHit {
  path: string;
  url: string;
  title: string;
  product: Product;
  text: string;
  score: number;
}

export async function searchDocs(
  query: string,
  opts: { product?: Product; k?: number } = {},
): Promise<SearchHit[]> {
  const { chunks } = load();
  const k = opts.k ?? 6;
  const qvec = await embedQuery(query);
  const pool = opts.product
    ? chunks.filter((c) => c.product === opts.product)
    : chunks;

  return pool
    .map((c) => ({
      path: c.path,
      url: c.url,
      title: c.title,
      product: c.product,
      text: c.text,
      score: cosineSimilarity(qvec, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function fetchDocByPath(p: string): Page | null {
  const { pages } = load();
  return pages[p] ?? null;
}

export function indexStats(): { chunks: number; pages: number } {
  const idx = load();
  return { chunks: idx.chunks.length, pages: Object.keys(idx.pages).length };
}
