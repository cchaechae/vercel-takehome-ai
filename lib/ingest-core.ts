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
