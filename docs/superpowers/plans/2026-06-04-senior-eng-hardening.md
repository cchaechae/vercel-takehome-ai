# Senior-Engineer Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the Vercel Docs Assistant to the quality bar of hand-written senior-engineer code — real unit tests, validated boundaries, no duplicated control flow, pure logic separated from I/O — and strip the stylistic tells of AI authorship.

**Architecture:** No behavior changes. Pure parsing/chunking logic moves out of the ingest script into a testable `lib/ingest-core.ts`; the index load gains a Zod boundary; the two duplicated provider-failover loops collapse into one `withFailover` helper used by both the streaming route and the eval agent. Tests are added with Vitest. Console/UI emoji and the grader-facing README tone are removed.

**Tech Stack:** Next.js 16 (App Router), AI SDK v6, TypeScript 5, Zod 4, Vitest (new dev dependency).

---

## File Structure

**New files:**
- `lib/ingest-core.ts` — pure, dependency-free parsing/chunking (`titleFromMarkdown`, `parseLinks`, `chunkText`) extracted from `scripts/ingest.ts`. One responsibility: text → links/chunks. No `fs`, no `fetch`.
- `lib/failover.ts` — `withFailover<T>()`: iterate `SYNTHESIS_MODELS`, return first success, support a non-retryable signal. The single source of truth for provider failover.
- `lib/ingest-core.test.ts`, `lib/embeddings.test.ts`, `lib/store.test.ts`, `lib/failover.test.ts` — unit tests colocated with the code they cover.

**Modified files:**
- `scripts/ingest.ts` — import the three pure helpers instead of defining them inline.
- `lib/embeddings.ts` — export `isRateLimit` for testing.
- `lib/store.ts` — replace the `as DocsIndex` cast with a Zod-validated `parseIndex`.
- `lib/agent.ts` — `generateAnswer` uses `withFailover`.
- `app/api/chat/route.ts` — streaming loop uses `withFailover`.
- `eval/run.ts` — assert the already-present `expectedUrlSubstring` (a new citation-accuracy metric).
- `components/chat.tsx`, `scripts/ingest.ts`, `eval/run.ts` — remove emoji from UI and console output.
- `README.md` — neutral, factual tone; drop the now-resolved "obvious next step" note.
- `package.json` — add `vitest` dev dependency and a `test` script.

---

## Task 1: Add the test runner

**Files:**
- Modify: `package.json:5-12` (scripts), `package.json:22-32` (devDependencies)
- Create: `lib/smoke.test.ts` (temporary — deleted in this task's final step)

- [ ] **Step 1: Install Vitest**

Run:
```bash
npm install -D vitest@^3
```
Expected: `vitest` appears under `devDependencies` in `package.json`; no peer-dependency errors.

- [ ] **Step 2: Add the `test` script**

Edit `package.json` `scripts` (after the `eval` line):
```json
    "eval": "node --env-file=.env.local --import tsx eval/run.ts",
    "test": "vitest run"
```

- [ ] **Step 3: Write a smoke test to prove the runner works**

Create `lib/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

describe('test runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npm test`
Expected: PASS — `1 passed (1)`.

- [ ] **Step 5: Delete the smoke test and commit**

```bash
rm lib/smoke.test.ts
git add package.json package-lock.json
git commit -m "chore: add vitest test runner"
```

---

## Task 2: Extract pure ingest logic into a testable module

**Files:**
- Create: `lib/ingest-core.ts`
- Create: `lib/ingest-core.test.ts`
- Modify: `scripts/ingest.ts` (remove inline helpers, import from `ingest-core`)

- [ ] **Step 1: Write the failing tests**

Create `lib/ingest-core.test.ts`:
```ts
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

  it('drops off-host and non-/docs links', () => {
    const links = parseLinks(md, 'nextjs.org');
    expect(links.some((l) => l.includes('other.com'))).toBe(false);
    expect(links.some((l) => l.includes('/blog/'))).toBe(false);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lib/ingest-core.test.ts`
Expected: FAIL — cannot resolve `./ingest-core`.

- [ ] **Step 3: Create the module**

Create `lib/ingest-core.ts`:
```ts
/** Pure parsing/chunking for the ingest pipeline — no fs, no fetch, so it is unit-testable. */

export const CHUNK_CHARS = 1400;
export const CHUNK_OVERLAP = 180;

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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- lib/ingest-core.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Use the module from `scripts/ingest.ts`**

In `scripts/ingest.ts`, add the import (next to the existing `lib/embeddings` import):
```ts
import { embedBatch } from '../lib/embeddings';
import { chunkText, parseLinks, titleFromMarkdown } from '../lib/ingest-core';
import type { Chunk, DocsIndex, Page, Product } from '../lib/store';
```

Delete the now-duplicated local constants and functions from `scripts/ingest.ts`:
- the `CHUNK_CHARS = 1400` and `CHUNK_OVERLAP = 180` constant lines,
- the entire `function titleFromMarkdown(...)`,
- the entire `function parseLinks(...)`,
- the entire `function chunkText(...)`.

Update the one `parseLinks` call site signature — it now takes the host, not the whole `Source`. In `collectUrls` and `ingestSource`, change every `parseLinks(<md>, src)` to `parseLinks(<md>, src.docHost)`.

- [ ] **Step 6: Verify the script still type-checks and tests still pass**

Run: `npm run typecheck && npm test`
Expected: no TypeScript errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/ingest-core.ts lib/ingest-core.test.ts scripts/ingest.ts
git commit -m "refactor: extract pure ingest logic into tested lib/ingest-core"
```

---

## Task 3: Test the rate-limit classifier

**Files:**
- Modify: `lib/embeddings.ts:12` (export `isRateLimit`)
- Create: `lib/embeddings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/embeddings.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lib/embeddings.test.ts`
Expected: FAIL — `isRateLimit` is not exported.

- [ ] **Step 3: Export the function**

In `lib/embeddings.ts`, add `export` to the existing declaration:
```ts
export function isRateLimit(err: unknown): boolean {
```
(No other change — the body stays exactly as is.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- lib/embeddings.test.ts`
Expected: PASS — 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/embeddings.ts lib/embeddings.test.ts
git commit -m "test: cover rate-limit classifier; export isRateLimit"
```

---

## Task 4: Validate the docs index at the load boundary

> **NOTE (corpus format):** The on-disk index is split. `data/docs-index.json` holds
> `{ dim: number, chunks: ChunkMeta[], pages: Record<string, Page> }` where
> `ChunkMeta = Omit<Chunk, 'embedding'>` (NO embedding field — vectors live in
> `data/embeddings.bin` as a packed Float32 blob, row-major in chunk order).
> `load()` reads the JSON, reads the blob, and attaches `embedding` per chunk by
> slicing `dim` floats. Validation therefore covers the JSON meta shape, and
> `load()` additionally checks the blob length matches `chunks.length * dim`
> (a desynced JSON/blob pair is the new failure mode this split format introduces).

**Files:**
- Modify: `lib/store.ts` (replace the `as DocsIndex` cast in `load()` with `parseIndex`; add a blob-length check)
- Create: `lib/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/store.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lib/store.test.ts`
Expected: FAIL — `parseIndex` is not exported.

- [ ] **Step 3: Add the schema and use it in `load()`**

In `lib/store.ts`, add the Zod import at the top (after the existing `import { embedQuery }` line):
```ts
import { z } from 'zod';
```

Add the schema and `parseIndex` just below the `DocsIndex` interface (keep the existing `Chunk` / `ChunkMeta` / `Page` / `DocsIndex` / `LoadedIndex` types exactly as they are — they remain the public types). The schema validates the persisted `ChunkMeta` shape (no `embedding`) and the `dim` field:
```ts
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
  return DocsIndexSchema.parse(raw) as DocsIndex;
}
```

Replace the JSON-parsing line and add a blob-length check in `load()`. The current body is:
```ts
function load(): LoadedIndex {
  if (cache) return cache;
  const dir = path.join(process.cwd(), 'data');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'docs-index.json'), 'utf8')) as DocsIndex;
  const buf = fs.readFileSync(path.join(dir, 'embeddings.bin'));
  const floats = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { dim } = meta;
  const chunks: Chunk[] = meta.chunks.map((c, i) => ({
    ...c,
    embedding: Array.from(floats.subarray(i * dim, (i + 1) * dim)),
  }));
  cache = { chunks, pages: meta.pages };
  return cache;
}
```
Change exactly two things — the `meta` line and a new guard after `floats` is built:
```ts
  const meta = parseIndex(JSON.parse(fs.readFileSync(path.join(dir, 'docs-index.json'), 'utf8')));
  const buf = fs.readFileSync(path.join(dir, 'embeddings.bin'));
  const floats = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { dim } = meta;
  if (floats.length !== meta.chunks.length * dim) {
    throw new Error(
      `embeddings.bin (${floats.length} floats) does not match docs-index.json (${meta.chunks.length} chunks x ${dim} dim). Re-run \`npm run ingest\`.`,
    );
  }
```
(Leave the `chunks` mapping and the `cache = ...` lines below unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- lib/store.test.ts`
Expected: PASS — 3 cases green.

- [ ] **Step 5: Verify the real index still validates and the app still answers**

Run: `npm run eval`
Expected: the harness loads `data/docs-index.json` through `parseIndex` and passes the blob-length check without throwing, then prints the scorecard. (Requires `.env.local` with `AI_GATEWAY_API_KEY` and a built corpus — run `npm run ingest` first if `data/embeddings.bin` is absent.)

- [ ] **Step 6: Commit**

```bash
git add lib/store.ts lib/store.test.ts
git commit -m "feat: validate docs index meta and embeddings.bin length at load"
```

---

## Task 5: Collapse the two provider-failover loops into one helper

**Files:**
- Create: `lib/failover.ts`
- Create: `lib/failover.test.ts`
- Modify: `lib/agent.ts:75-94` (`generateAnswer`)
- Modify: `app/api/chat/route.ts:18-64` (streaming loop)

- [ ] **Step 1: Write the failing tests**

Create `lib/failover.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lib/failover.test.ts`
Expected: FAIL — cannot resolve `./failover`.

- [ ] **Step 3: Create the helper**

Create `lib/failover.ts`:
```ts
import { SYNTHESIS_MODELS } from './models';

interface FailoverOpts {
  /** Defaults to the configured synthesis models. */
  models?: readonly string[];
  /** Return false to stop failover and rethrow (e.g. a stream already emitted content). */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Run `fn` against each model in order, returning the first success. On a
 * retryable error it advances to the next model; a non-retryable error rethrows
 * immediately. Throws the last error if every model fails.
 */
export async function withFailover<T>(
  fn: (model: string) => Promise<T>,
  opts: FailoverOpts = {},
): Promise<T> {
  const models = opts.models ?? SYNTHESIS_MODELS;
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastError: unknown;
  for (const model of models) {
    try {
      return await fn(model);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }
  throw lastError ?? new Error('All models failed');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- lib/failover.test.ts`
Expected: PASS — 4 cases green.

- [ ] **Step 5: Rewrite `generateAnswer` to use the helper**

In `lib/agent.ts`, replace the entire `generateAnswer` function (the current `for` loop over `SYNTHESIS_MODELS`) with:
```ts
/** Non-streaming answer (used by the eval harness). Mirrors the route's agent. */
export async function generateAnswer(question: string): Promise<{ text: string; model: string }> {
  return withFailover(async (model) => {
    const { text } = await generateText({
      model,
      system: SYSTEM,
      prompt: question,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      prepareStep,
    });
    return { text, model };
  });
}
```

Update the imports at the top of `lib/agent.ts`:
```ts
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchDocByPath, searchDocs } from './store';
import { RELEVANCE_THRESHOLD } from './models';
import { withFailover } from './failover';
```
(`SYNTHESIS_MODELS` is no longer referenced here — remove it from this import.)

- [ ] **Step 6: Rewrite the route's streaming loop to use the helper**

In `app/api/chat/route.ts`, replace the imports and the `execute` body. New file contents:
```ts
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai';
import { MAX_STEPS, prepareStep, SYSTEM, tools } from '@/lib/agent';
import { withFailover } from '@/lib/failover';

export const maxDuration = 60;

/** Thrown once a stream has emitted content — the request can no longer fail over. */
class StreamCommittedError extends Error {}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const modelMessages = await convertToModelMessages(messages);

  const stream = createUIMessageStream({
    onError: () => 'Something went wrong. Please try again.',
    execute: async ({ writer }) => {
      await withFailover(
        async (model) => {
          const result = streamText({
            model,
            system: SYSTEM,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(MAX_STEPS),
            prepareStep,
          });

          let producedContent = false;
          try {
            const uiStream = result.toUIMessageStream({
              sendSources: true,
              onError: (e) => (e instanceof Error ? e.message : String(e)),
            });

            for await (const part of uiStream) {
              if (part.type === 'error') {
                // Early failure (bad model, auth, provider down) before any content
                // -> retryable, so fail over to the next provider.
                if (!producedContent) throw new Error(part.errorText ?? 'model error');
                writer.write(part);
                return;
              }
              if (part.type === 'text-delta' || part.type.startsWith('tool')) {
                producedContent = true;
              }
              writer.write(part);
            }
          } catch (err) {
            // A mid-stream failure can't be cleanly retried; mark it non-retryable.
            if (producedContent) throw new StreamCommittedError(String(err));
            throw err;
          }
        },
        { isRetryable: (err) => !(err instanceof StreamCommittedError) },
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
```

- [ ] **Step 7: Verify type-check, lint, and the full unit suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors; all tests pass. (`route.ts` has no standalone unit test — its failover semantics are covered by `lib/failover.test.ts`; type-check confirms the wiring.)

- [ ] **Step 8: Smoke-test the route manually**

Run: `npm run dev`, open http://localhost:3000, ask one of the sample questions, and confirm a streamed, cited answer renders.
Expected: answer streams with a tool trace and a `Sources:` list — same behavior as before the refactor.

- [ ] **Step 9: Commit**

```bash
git add lib/failover.ts lib/failover.test.ts lib/agent.ts app/api/chat/route.ts
git commit -m "refactor: unify provider failover into a single withFailover helper"
```

---

## Task 6: Make the eval assert citation accuracy

The `expectedUrlSubstring` field already exists in `eval/dataset.json` for every answerable case but is silently ignored. The README calls this "the obvious next step." Wire it in.

**Files:**
- Modify: `eval/run.ts`

- [ ] **Step 1: Extend the `Item` type and thresholds**

In `eval/run.ts`, update the `Item` interface and `THRESHOLDS`:
```ts
interface Item {
  question: string;
  answerable: boolean;
  keywords?: string[];
  expectedUrlSubstring?: string;
}

const THRESHOLDS = { retrieval: 0.75, grounding: 0.75, citation: 0.75, abstention: 1.0 };
```

- [ ] **Step 2: Count citation hits in the loop**

In `eval/run.ts`, add a counter beside the others:
```ts
  let retrievalHits = 0;
  let groundingHits = 0;
  let citationHits = 0;
  let abstentions = 0;
```

Inside the `if (item.answerable)` branch, after `grounded` is computed, add the citation check and fold it into the log line:
```ts
      const retrieved = (top?.score ?? 0) >= RELEVANCE_THRESHOLD;
      const grounded = hasKeywords(text, item.keywords) && citesDocs;
      const citedRightPage =
        !item.expectedUrlSubstring ||
        text.toLowerCase().includes(item.expectedUrlSubstring.toLowerCase());
      if (retrieved) retrievalHits++;
      if (grounded) groundingHits++;
      if (citedRightPage) citationHits++;
      console.log(
        `${retrieved && grounded && citedRightPage ? '[PASS]' : '[FAIL]'} [answerable] ${item.question}\n` +
          `   retrieval=${retrieved ? 'ok' : 'MISS'} (top=${top?.score.toFixed(2)}, ${top?.url ?? '-'}) | ` +
          `grounded=${grounded ? 'ok' : 'MISS'} | citation=${citedRightPage ? 'ok' : 'MISS'} (want "${item.expectedUrlSubstring ?? '-'}")`,
      );
```

- [ ] **Step 3: Add the rate to the scorecard and the gate**

Replace the scorecard/gate block at the bottom of `main()`:
```ts
  const retrievalRate = retrievalHits / answerable.length;
  const groundingRate = groundingHits / answerable.length;
  const citationRate = citationHits / answerable.length;
  const abstentionRate = abstentions / unanswerable.length;

  console.log('\n-------- Scorecard --------');
  console.log(`Retrieval hit rate : ${(retrievalRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.retrieval * 100}%)`);
  console.log(`Grounding rate     : ${(groundingRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.grounding * 100}%)`);
  console.log(`Citation accuracy  : ${(citationRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.citation * 100}%)`);
  console.log(`Abstention rate    : ${(abstentionRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.abstention * 100}%)`);

  const pass =
    retrievalRate >= THRESHOLDS.retrieval &&
    groundingRate >= THRESHOLDS.grounding &&
    citationRate >= THRESHOLDS.citation &&
    abstentionRate >= THRESHOLDS.abstention;

  console.log(`\n${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
```

- [ ] **Step 4: Run the eval**

Run: `npm run eval`
Expected: scorecard now includes a `Citation accuracy` line; the run still exits 0 (passes). If citation accuracy lands below 75%, that is a real finding — note which questions missed before adjusting the threshold; do not lower it to force a green.

- [ ] **Step 5: Commit**

```bash
git add eval/run.ts
git commit -m "feat(eval): assert cited source URL (citation accuracy metric)"
```

---

## Final verification

- [ ] **Run the full gate**

```bash
npm run typecheck && npm run lint && npm test && npm run eval
```
Expected: type-check clean, lint clean, all Vitest suites pass, eval scorecard passes (exit 0).

- [ ] **Review the diff against the goal**

```bash
git log --oneline -8
git diff main --stat
```
Expected: every changed line traces to a task above; no behavior change to the agent, only structure, validation, and tests.

---

## Self-Review

**Scope (substance only, Tasks 1–6):** tests (Tasks 1–5), validated index boundary (Task 4), unified failover (Task 5), pure-logic/I-O separation (Task 2), wired-up eval data (Task 6). The stylistic pass (emoji removal, README tone) was deliberately cut from this plan.

**Placeholder scan** — every code step contains complete code; every command has an expected result. No "add error handling" / "TBD" / "similar to above".

**Type consistency** — `withFailover(fn, opts)` signature is identical across its definition (Task 5 Step 3), its tests (Step 1), and both call sites (Steps 5–6). `parseIndex` is used in `load()` and tested with the same shape. `parseLinks(markdown, docHost)` — the host-string signature — matches between `lib/ingest-core.ts`, its tests, and the updated `scripts/ingest.ts` call sites. `Item.expectedUrlSubstring` matches the field already present in `eval/dataset.json`.

**Known limitation (out of scope, intentional):** the in-memory linear cosine scan and unquantized embedding JSON are unchanged — the README already documents pgvector as the scale path, and changing it would alter runtime behavior, which this plan deliberately avoids.
