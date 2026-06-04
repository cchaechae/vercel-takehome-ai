import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { fetchDocByPath, searchDocs } from './store';
import { RELEVANCE_THRESHOLD, SYNTHESIS_MODELS } from './models';

export const MAX_STEPS = 6;

// On the final allowed step, forbid tools so the model MUST produce a text
// answer — prevents the loop from ending tool-only with an empty response.
export const prepareStep = ({ stepNumber }: { stepNumber: number }) =>
  stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' as const } : {};

const productEnum = z.enum(['vercel', 'nextjs', 'ai-sdk']);

export const tools = {
  searchDocs: tool({
    description:
      'Semantic search over the Vercel, Next.js, and AI SDK documentation. ' +
      'Call this first to ground every answer. Optionally scope to one product.',
    inputSchema: z.object({
      query: z.string().describe('A focused natural-language search query'),
      product: productEnum.optional().describe('Restrict search to one product'),
    }),
    execute: async ({ query, product }) => {
      const hits = await searchDocs(query, { product, k: 6 });
      const top = hits[0]?.score ?? 0;
      if (top < RELEVANCE_THRESHOLD) {
        return {
          relevant: false,
          topScore: top,
          note: 'No sufficiently relevant documentation found. Tell the user you could not find this in the docs; do not guess.',
          results: [],
        };
      }
      return {
        relevant: true,
        topScore: top,
        results: hits.map((h) => ({
          path: h.path,
          title: h.title,
          url: h.url,
          product: h.product,
          score: Number(h.score.toFixed(3)),
          excerpt: h.text.slice(0, 700),
        })),
      };
    },
  }),

  fetchDoc: tool({
    description:
      'Fetch the FULL text of a documentation page by its `path` (as returned by searchDocs). ' +
      'Use when a search excerpt is truncated or you need a complete code example or end-to-end guide.',
    inputSchema: z.object({
      path: z.string().describe('The `path` field from a searchDocs result'),
    }),
    execute: async ({ path }) => {
      const page = fetchDocByPath(path);
      if (!page) return { found: false, note: `No page for path "${path}".` };
      return { found: true, title: page.title, url: page.url, text: page.text.slice(0, 8000) };
    },
  }),
};

export const SYSTEM = `You are a documentation support assistant for Vercel, Next.js, and the AI SDK.

Rules:
- Ground every answer in the documentation. ALWAYS call searchDocs before answering a docs question.
- If a search excerpt is cut off or you need a full code example, call fetchDoc with the result's path.
- Cite your sources: end every grounded answer with a "Sources:" list. For each source include its title AND its full https URL exactly as returned by the tools (e.g. https://vercel.com/docs/...). Never list a source without its URL.
- If searchDocs returns relevant: false (or nothing on-topic), say you could not find it in the Vercel / Next.js / AI SDK docs and suggest where the user might look. NEVER invent APIs, flags, config options, or version numbers.
- Be concise and concrete. Prefer the official terminology from the docs.
- For greetings or meta questions you may answer briefly without searching.`;

/** Non-streaming answer (used by the eval harness). Mirrors the route's agent. */
export async function generateAnswer(question: string): Promise<{ text: string; model: string }> {
  let lastError: unknown;
  for (const model of SYNTHESIS_MODELS) {
    try {
      const { text } = await generateText({
        model,
        system: SYSTEM,
        prompt: question,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        prepareStep,
      });
      return { text, model };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('All models failed');
}
