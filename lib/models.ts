// Tried in order. The fallback is a different provider so a single provider's
// outage or rate-limit doesn't take the assistant down.
export const SYNTHESIS_MODELS = [
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.4',
] as const;

// Minimum cosine similarity for a retrieved chunk to count as relevant; below
// this, searchDocs reports no match and the assistant abstains.
export const RELEVANCE_THRESHOLD = 0.3;
