'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState } from 'react';

const SAMPLES = [
  'How do I use the `use cache` directive with cacheLife in Next.js?',
  'How do I stream a chat response with the AI SDK useChat hook?',
  'What is Fluid Compute and how does it reduce cold starts?',
];

const PRODUCT_STYLE: Record<string, string> = {
  vercel: 'bg-white text-black',
  nextjs: 'bg-neutral-800 text-white',
  'ai-sdk': 'bg-indigo-600 text-white',
};

type ToolResult = {
  relevant?: boolean;
  results?: { title: string; url: string; product: string; score: number }[];
  found?: boolean;
  title?: string;
  url?: string;
};

function ToolCall({ part }: { part: { type: string; state?: string; input?: unknown; output?: unknown } }) {
  const name = part.type.replace('tool-', '');
  const input = part.input as { query?: string; path?: string } | undefined;
  const output = part.output as ToolResult | undefined;
  const running = part.state !== 'output-available';

  return (
    <div className="my-2 rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-neutral-400">
        <span>{name === 'searchDocs' ? '🔎' : '📄'}</span>
        <span className="font-mono">{name}</span>
        {input?.query && <span className="text-neutral-300">“{input.query}”</span>}
        {input?.path && <span className="font-mono text-neutral-300">{input.path}</span>}
        {running && <span className="animate-pulse text-neutral-500">…</span>}
      </div>
      {output?.results && output.results.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {output.results.slice(0, 5).map((r, i) => (
            <li key={`${r.url}-${i}`} className="flex items-center gap-2">
              <span className={`rounded px-1 text-[10px] ${PRODUCT_STYLE[r.product] ?? 'bg-neutral-700'}`}>
                {r.product}
              </span>
              <a href={r.url} target="_blank" rel="noreferrer" className="text-neutral-300 hover:underline">
                {r.title}
              </a>
              <span className="text-neutral-600">{r.score.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
      {output?.relevant === false && <div className="mt-1 text-amber-500">no relevant docs — assistant will abstain</div>}
      {output?.found && output.url && (
        <div className="mt-1">
          <a href={output.url} target="_blank" rel="noreferrer" className="text-neutral-300 hover:underline">
            {output.title}
          </a>
        </div>
      )}
    </div>
  );
}

export default function Chat() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  function submit(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput('');
  }

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col px-4">
      <header className="py-5">
        <h1 className="text-lg font-semibold">Vercel Docs Assistant</h1>
        <p className="text-sm text-neutral-500">
          Grounded RAG over Vercel · Next.js · AI SDK docs. Cites sources, abstains when unsure.
        </p>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">Try asking:</p>
            {SAMPLES.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                className="block w-full rounded-lg border border-neutral-800 px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {m.parts.map((part, i) => {
              if (part.type === 'text') {
                return (
                  <div key={i} className="whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-100">
                    {part.text}
                  </div>
                );
              }
              if (part.type.startsWith('tool-')) {
                return <ToolCall key={i} part={part as never} />;
              }
              return null;
            })}
          </div>
        ))}

        {status === 'submitted' && <div className="animate-pulse text-sm text-neutral-500">Thinking…</div>}
        {error && <div className="text-sm text-red-500">Something went wrong. Please try again.</div>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex gap-2 border-t border-neutral-800 py-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about Vercel, Next.js, or the AI SDK…"
          className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
