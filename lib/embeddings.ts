import { embed, embedMany } from 'ai';

// Cheap, fast embedding model — the workhorse for both ingest and query time.
// Cost/latency note: ~$0.02 / 1M tokens, so ingesting the whole corpus costs cents.
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: EMBEDDING_MODEL, value: text });
  return embedding;
}

export function isRateLimit(err: unknown): boolean {
  const e = err as { statusCode?: number; cause?: { statusCode?: number }; lastError?: { statusCode?: number }; message?: string };
  if ([e?.statusCode, e?.cause?.statusCode, e?.lastError?.statusCode].includes(429)) return true;
  return /rate.?limit|\b429\b|free tier/i.test(String(e?.message ?? ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries on Gateway free-tier rate limits (429) with exponential backoff.
export async function embedBatch(values: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { embeddings } = await embedMany({
        model: EMBEDDING_MODEL,
        values,
        maxParallelCalls: 1,
      });
      return embeddings;
    } catch (err) {
      if (!isRateLimit(err) || attempt >= 6) throw err;
      const wait = Math.min(60_000, 8_000 * 2 ** attempt);
      console.warn(`  rate-limited; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
