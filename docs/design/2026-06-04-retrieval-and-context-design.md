# Retrieval, Context Window & Chunking — Design Notes

## Scope

Demo as-is: ~105 pages / 1,118 chunks of Vercel · Next.js · AI SDK docs, served
in-memory with brute-force cosine. No vector DB. These notes optimize the current
shape; the enterprise scale-path is called out only where it changes the reasoning.

## The framing that drives every decision

The entire corpus is ~1,118 chunks ≈ **~400k tokens**. Model context windows are
200k–1M. So **capacity is not the constraint at this scale — retrieval precision
is.** The failure mode isn't "not enough room," it's packing low-signal chunks
that bury the answer (lost-in-the-middle) and add latency/cost.

Design principle: **retrieve wide, filter hard, pack lean.** Matching the
strategy to the scale — rather than reaching for a vector DB or a bigger model —
is the point.

## 1. Context-window budget

- Target a **lean per-answer budget (~4–8k tokens of retrieved text)**, not "fill
  the window."
- Keep the current **search → fetch** agent pattern (`lib/agent.ts`): a cheap wide
  scan returning short excerpts, then *selectively* pull one full page via
  `fetchDoc`. This is the correct "context gathering for agents" shape — wide
  recall up front, deep context only on demand.
- Tuning: excerpts ~1,000–1,200 chars, k≈8, **dedup by page** before packing.
  Don't pack all top-k full pages.
- Why not long-context stuffing: even though the corpus *could* fit a lot, more
  context ≠ better answers — precision in what reaches the model wins on both
  quality and latency.

## 2. Model choice

**Embedding** — keep `text-embedding-3-small` (1536-dim, `lib/embeddings.ts`).
- `-3-large` (3072-dim) buys marginal recall for ~2× cost/latency — not worth it
  at 100 pages. The higher-ROI precision lever is rerank/hybrid, not a bigger
  embedder.

**Synthesis** — keep `anthropic/claude-sonnet-4.6` primary, `openai/gpt-5.4`
cross-provider fallback (`lib/models.ts`).
- The task is "ground in retrieved docs, cite sources, abstain when unsure" —
  **instruction-following matters more than raw reasoning.** Sonnet-4.6 is a sound
  primary for citation/abstention discipline.
- Cost/latency lever: with good retrieval, a smaller model (Haiku / `gpt-5-mini`)
  may hold quality — the eval harness is exactly where to A/B that.
- Keep the **cross-provider** fallback: one provider's outage/rate-limit doesn't
  take the assistant down.

## 3. Chunking strategy

Current: paragraph-aware fixed-size (~1,400 chars / 180 overlap) in
`lib/ingest-core.ts:33`. Two improvements matter for *docs*:

- **Structure-aware (header-based) chunking.** Split on markdown headings — one
  chunk per section, sub-split large sections at ~300–500 tokens on paragraph
  boundaries. Prepend + embed a **breadcrumb** ("Vercel › Functions › Fluid
  Compute") so section titles sharpen retrieval and chunks are self-contained.
- **Guard fenced code blocks.** `split(/\n{2,}/)` (`lib/ingest-core.ts:34`) breaks
  on blank lines *inside* ``` blocks, fragmenting code examples — a real
  correctness issue for a developer-docs assistant.
- **Overlap.** With header anchoring, little/no char overlap is needed; the
  current `slice(-CHUNK_OVERLAP)` (`lib/ingest-core.ts:40`) can cut mid-token.
  `fetchDoc` already recovers full context, so favor section integrity over
  overlap.
- **Size.** ~300–500 tokens is the precision sweet spot for doc QA; keep near
  current.

## 4. Retrieval infrastructure (in-memory, no DB)

- Brute-force cosine over ~1.1k chunks is <5ms — **keep it.** A vector DB here
  would be infrastructure the scale doesn't justify. (pgvector / a managed vector
  store is the scale-path past ~10⁵ chunks — that's the enterprise-pitch hook, not
  a demo need.)
- Highest-ROI upgrade is **precision**, not capacity:
  - **Hybrid lexical + vector** — blend BM25/substring on titles & code with
    cosine. Pure vectors miss exact API tokens (`use cache`, `cacheLife`); lexical
    catches them. Zero new infrastructure.
  - **Rerank** — over-fetch top-20 by cosine, rerank to top-6 with a cross-encoder
    or hosted reranker (Cohere/Voyage). Biggest precision win; adds one dependency
    + minor latency.
- **Abstention gate.** `RELEVANCE_THRESHOLD = 0.3` (`lib/models.ts`) on raw cosine
  is blunt. Prefer the better-calibrated blended/rerank score, calibrated against
  the eval set rather than asserted.

## 5. Context gathering for the agent

- Keep the two-tool **search → fetch** loop with `stepCountIs(6)` and a forced
  final text answer (`lib/agent.ts`) — good bounded-loop hygiene.
- Tuning: k=8–12 candidates with short excerpts, **dedup by page**; make
  `fetchDoc` section-aware (pull the relevant section, not a fixed 8k chars); cap
  total gathered context ~6–8k tokens.

## Approaches considered

- **A — Tune the current pipeline (recommended).** Header + code-fence-aware
  chunking, dedup-by-page, eval-calibrated abstention threshold. No new deps;
  cleanest "strategy matched to scale" story.
- **B — A + a precision layer.** Hybrid lexical+vector and/or a hosted reranker,
  abstention gated on the rerank score. Best answer quality; one dependency +
  minor latency. Still demo-scale (no vector DB).
- **C — Long-context fetch-first (avoid).** Lean on stuffing whole top pages into
  a long-context model. Simplest retrieval code, but worse cost/latency and
  lost-in-the-middle, and it discards the disciplined-context narrative.

**Recommendation: A now; add B only if the eval surfaces precision gaps. Avoid C.**

## How this maps to the interview rubric

- *Prompting / context selection / fallback* — lean context budget, search→fetch
  gathering, abstain-on-low-confidence, cross-provider failover.
- *Model / cost / latency / safety* — small embedder + mid-tier synth justified by
  scale; abstain-before-synthesis spend control; grounded-and-cited answers.
- *Enterprise pitch* — same pattern, swap corpus; the scale-path (rerank →
  pgvector/managed VDB → multi-tenant ACLs) is the upsell, deliberately out of
  scope for the demo.
