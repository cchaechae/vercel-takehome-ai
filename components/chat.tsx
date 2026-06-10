'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useState } from 'react';
import { Streamdown } from 'streamdown';
import { chatStore } from '@/lib/chat-store';

const SAMPLES = [
  { text: 'How do I use the `use cache` directive with cacheLife in Next.js?', tag: 'Next.js' },
  { text: 'How do I stream a chat response with the AI SDK useChat hook?', tag: 'AI SDK' },
  { text: 'What is Fluid Compute and how does it reduce cold starts?', tag: 'Compute' },
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

function Logo({ size }: { size: 'lg' | 'sm' }) {
  const box = size === 'lg' ? 'h-11 w-11 rounded-xl' : 'h-7 w-7 rounded-lg';
  return (
    <div className={`grid shrink-0 place-items-center bg-white text-black ${box}`}>
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-1/2 w-1/2">
        <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" />
      </svg>
    </div>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d={d} />
    </svg>
  );
}

function ToolCall({ part }: { part: { type: string; state?: string; input?: unknown; output?: unknown } }) {
  const name = part.type.replace('tool-', '');
  const input = part.input as { query?: string; path?: string } | undefined;
  const output = part.output as ToolResult | undefined;
  const running = part.state !== 'output-available';

  return (
    <div className="my-2 rounded-xl border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs">
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

export default function Chat({ chatId }: { chatId: string }) {
  const { messages, setMessages, sendMessage, status, error } = useChat({
    id: chatId,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';
  const started = messages.length > 0;

  // Hydrate from the store after mount (client-only → no hydration mismatch),
  // and re-load when navigating to a different chat.
  useEffect(() => {
    setMessages(chatStore.load(chatId));
  }, [chatId, setMessages]);

  // Persist once a turn settles. Skipped while streaming; if the tab closes
  // mid-stream that answer is lost (the client is the only writer here).
  useEffect(() => {
    if (!busy && messages.length) chatStore.save(chatId, messages);
  }, [busy, messages, chatId]);

  function submit(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput('');
  }

  const composer = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(input);
      }}
      className="flex items-center gap-2 rounded-2xl border border-neutral-800 bg-neutral-900 px-3 py-2"
    >
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Ask a question…"
        className="flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-neutral-500"
      />
      <button
        type="submit"
        disabled={busy}
        aria-label="Send"
        className="grid h-8 w-8 place-items-center rounded-lg bg-white text-black disabled:opacity-40"
      >
        <Icon d="M12 19V5M5 12l7-7 7 7" />
      </button>
    </form>
  );

  // Landing state: centered hero. Collapses to the compact header below once a
  // message is sent (messages.length > 0).
  if (!started) {
    return (
      <div className="mx-auto flex h-dvh w-full max-w-[46rem] flex-col overflow-y-auto px-4">
        <div className="m-auto w-full py-8">
          <div className="flex flex-col items-center text-center">
            <Logo size="lg" />
            <h1 className="mt-4 text-2xl font-semibold">Vercel Docs Assistant</h1>
            <p className="mt-2 max-w-md text-sm text-neutral-400">
              Ask anything about Vercel, Next.js, and the AI SDK. Every answer is grounded in the official docs.
            </p>
            <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Grounded · cites sources
            </span>
          </div>

          <div className="mt-6">{composer}</div>

          <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-neutral-500">Try asking</p>
          <div className="space-y-2">
            {SAMPLES.map((s) => (
              <button
                key={s.text}
                onClick={() => submit(s.text)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/50 px-4 py-3 text-left hover:bg-neutral-900"
              >
                <span className="text-sm text-neutral-200">{s.text}</span>
                <span className="flex shrink-0 items-center gap-2 text-neutral-500">
                  <span className="rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px]">{s.tag}</span>
                  <Icon d="M9 6l6 6-6 6" />
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Chat state: compact header on top, messages scroll, composer pinned bottom.
  return (
    <div className="mx-auto flex h-dvh w-full max-w-[46rem] flex-col px-4">
      <header className="flex items-center gap-2 py-4">
        <Logo size="sm" />
        <span className="text-sm font-semibold">Vercel Docs Assistant</span>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto pb-4">
        {messages.map((m) => (
          <div key={m.id}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {m.parts.map((part, i) => {
              if (part.type === 'text') {
                return (
                  <Streamdown key={i} className="text-[15px] leading-relaxed text-neutral-100">
                    {part.text}
                  </Streamdown>
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

      <div className="border-t border-neutral-800 py-4">{composer}</div>
    </div>
  );
}
