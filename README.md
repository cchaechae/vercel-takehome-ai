# Vercel Docs Assistant

A grounded support assistant over the official Vercel, Next.js, and AI SDK
documentation. It answers developer questions with citations, decides when to
search vs. pull a full page vs. abstain, and fails over across providers via the
AI Gateway.

Built with Next.js (App Router), AI SDK v6, and the AI Gateway. Deploys to
Vercel with no extra infrastructure.

## Approach

A plain RAG pipeline (`embed → retrieve → stuff → answer`) makes no decisions.
This one gives the model two tools and a bounded loop, so it can re-query,
escalate to a full page, or refuse when retrieval comes up empty.

The corpus is swappable: point the ingest script at any `llms.txt` (or any
markdown set) and the same assistant serves a different knowledge base.

## Architecture

```
ingest (offline, once)          data/docs-index.json          request time
┌───────────────────┐          ┌──────────────────┐          ┌──────────────────────────┐
│ llms.txt indexes  │          │ chunks + vectors │          │ POST /api/chat           │
│  vercel / nextjs  │  ──────► │ full pages by    │  ──────► │ streamText + tools loop  │
│  / ai-sdk         │ fetch.md │ path             │  load    │  searchDocs → fetchDoc    │
│ chunk + embed     │          └──────────────────┘  once    │  → grounded answer        │
└───────────────────┘                                        │  → abstain / failover     │
                                                              └──────────────────────────┘
                                                                         │ stream
                                                              useChat UI (citations + tool trace)
```

- **Ingest** (`scripts/ingest.ts`): parse each product's `llms.txt` link index,
  fetch every page as markdown (the `.md` endpoint), chunk (~1.4k chars, small
  overlap), embed with `text-embedding-3-small`, and write one JSON file. No
  scraping or DB at runtime.
- **Store** (`lib/store.ts`): loads the JSON once into memory; `searchDocs` does
  a cosine-similarity scan, `fetchDocByPath` is a keyed full-page lookup.
- **Agent** (`lib/agent.ts` + `app/api/chat/route.ts`): an AI SDK tool-calling
  loop bounded by `stepCountIs(6)`.
- **UI** (`components/chat.tsx`): `useChat` streaming; renders the answer, the
  tool calls, and clickable source links.

## The two tools

| Tool | Purpose | When the model uses it |
|---|---|---|
| `searchDocs(query, product?)` | semantic search, returns top-k chunks + scores | to ground an answer; optionally scoped to one product |
| `fetchDoc(path)` | returns the full page for a path search surfaced | when an excerpt is truncated or a complete example is needed |

## Quick start

```bash
npm install
echo "AI_GATEWAY_API_KEY=your_key_here" > .env.local   # https://vercel.com/dashboard → AI Gateway → API Keys
npm run ingest        # build data/docs-index.json (one-time, ~1–2 min)
npm run dev           # http://localhost:3000
npm run eval          # run the regression scorecard
```

## Notes & tradeoffs

- **Chunking**: paragraph-aware ~1.4k-char chunks with overlap so code blocks
  and steps survive cuts; `fetchDoc` recovers the full page when a chunk isn't
  enough.
- **Abstention**: if top similarity is below `RELEVANCE_THRESHOLD`
  (`lib/models.ts`), `searchDocs` reports no match and the system prompt
  instructs a refusal instead of a guess.
- **Models**: `text-embedding-3-small` for embeddings;
  `anthropic/claude-sonnet-4.6` for synthesis with `openai/gpt-5.4` as a
  cross-provider fallback. Low-confidence queries abstain before a synthesis
  call runs.
- **Failover (two layers)**: low retrieval confidence → abstain; provider error
  before any content is emitted → fail over to the next model in
  `SYNTHESIS_MODELS`. A mid-stream error can't be cleanly retried, so it
  surfaces to the user.

## Evaluation

`npm run eval` runs `eval/dataset.json` with deterministic (no-LLM-judge)
checks and prints a scorecard that gates on retrieval hit rate, grounding rate,
and abstention rate. Exits non-zero below threshold, so it works as a CI gate.
This is intentionally lightweight; the obvious next step is asserting the cited
source URL and adding a faithfulness check.

## Out of scope

- No persistent DB / pgvector — in-memory JSON keeps the demo zero-infra.
  pgvector is the scale path.
- No multi-agent planner — one bounded tool loop.
- No auth / multi-tenant.
