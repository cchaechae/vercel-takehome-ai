/**
 * Lightweight eval / hallucination-regression harness.
 *
 * For each question it checks, deterministically (no LLM judge):
 *   - Retrieval: does semantic search clear the relevance threshold? (answerable)
 *   - Grounding: does the answer hit expected keywords AND cite one of OUR doc
 *     domains? (answerable)
 *   - Abstention: for out-of-scope questions, does the assistant refuse instead
 *     of fabricating a docs-grounded answer (i.e. NOT cite our docs)? (unanswerable)
 *
 * Exits non-zero if any metric falls below threshold — usable as a CI gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateAnswer } from '../lib/agent';
import { searchDocs } from '../lib/store';
import { RELEVANCE_THRESHOLD } from '../lib/models';

interface Item {
  question: string;
  answerable: boolean;
  keywords?: string[];
}

// A grounded, on-topic answer cites one of the three documentation sources.
// An abstention points elsewhere (or nowhere) — it does not cite our docs.
const DOC_CITATION = /(vercel\.com\/docs|nextjs\.org\/docs|ai-sdk\.dev\/docs)/i;

const THRESHOLDS = { retrieval: 0.75, grounding: 0.75, abstention: 1.0 };

function hasKeywords(text: string, kws: string[] = []): boolean {
  const lower = text.toLowerCase();
  return kws.every((k) => lower.includes(k.toLowerCase()));
}

async function main() {
  const items: Item[] = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'eval', 'dataset.json'), 'utf8'),
  );

  const answerable = items.filter((i) => i.answerable);
  const unanswerable = items.filter((i) => !i.answerable);

  let retrievalHits = 0;
  let groundingHits = 0;
  let abstentions = 0;

  console.log(`Running ${items.length} eval cases (${answerable.length} answerable, ${unanswerable.length} unanswerable)\n`);

  for (const item of items) {
    const hits = await searchDocs(item.question, { k: 6 });
    const top = hits[0];
    const { text } = await generateAnswer(item.question);
    const citesDocs = DOC_CITATION.test(text);

    if (item.answerable) {
      const retrieved = (top?.score ?? 0) >= RELEVANCE_THRESHOLD;
      const grounded = hasKeywords(text, item.keywords) && citesDocs;
      if (retrieved) retrievalHits++;
      if (grounded) groundingHits++;
      console.log(
        `${retrieved && grounded ? '✅' : '❌'} [answerable] ${item.question}\n` +
          `   retrieval=${retrieved ? 'ok' : 'MISS'} (top=${top?.score.toFixed(2)}, ${top?.url ?? '-'}) | grounded=${grounded ? 'ok' : 'MISS'} | citesDocs=${citesDocs}`,
      );
    } else {
      const abstained = !citesDocs;
      if (abstained) abstentions++;
      console.log(
        `${abstained ? '✅' : '❌'} [unanswerable] ${item.question}\n` +
          `   abstained=${abstained ? 'ok' : 'FABRICATED (cited our docs)'} (top=${top?.score.toFixed(2)})`,
      );
    }
  }

  const retrievalRate = retrievalHits / answerable.length;
  const groundingRate = groundingHits / answerable.length;
  const abstentionRate = abstentions / unanswerable.length;

  console.log('\n──────── Scorecard ────────');
  console.log(`Retrieval hit rate : ${(retrievalRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.retrieval * 100}%)`);
  console.log(`Grounding rate     : ${(groundingRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.grounding * 100}%)`);
  console.log(`Abstention rate    : ${(abstentionRate * 100).toFixed(0)}%  (threshold ${THRESHOLDS.abstention * 100}%)`);

  const pass =
    retrievalRate >= THRESHOLDS.retrieval &&
    groundingRate >= THRESHOLDS.grounding &&
    abstentionRate >= THRESHOLDS.abstention;

  console.log(`\n${pass ? '✅ PASS' : '❌ FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
