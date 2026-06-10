'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { chatStore, type ChatSummary } from '@/lib/chat-store';

export default function Sidebar() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const pathname = usePathname();
  const router = useRouter();

  // localStorage writes don't fire a `storage` event in the same tab, so the
  // store emits `chat-store-change` for same-tab updates; `storage` covers other tabs.
  useEffect(() => {
    const refresh = () => setChats(chatStore.list());
    refresh();
    window.addEventListener('chat-store-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('chat-store-change', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  function newChat() {
    router.push(`/chat/${crypto.randomUUID()}`);
  }

  function del(id: string) {
    chatStore.remove(id);
    if (pathname === `/chat/${id}`) router.push('/');
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 p-3 sm:flex">
      <button
        onClick={newChat}
        className="mb-3 rounded-lg border border-neutral-800 px-3 py-2 text-sm hover:bg-neutral-900"
      >
        + New chat
      </button>
      <nav className="flex-1 space-y-1 overflow-y-auto">
        {chats.map((c) => {
          const active = pathname === `/chat/${c.id}`;
          return (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
                active ? 'bg-neutral-900' : 'hover:bg-neutral-900/50'
              }`}
            >
              <a href={`/chat/${c.id}`} className="flex-1 truncate text-neutral-200">
                {c.title}
              </a>
              <button
                onClick={() => del(c.id)}
                aria-label="Delete chat"
                className="text-neutral-500 opacity-0 hover:text-red-400 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
