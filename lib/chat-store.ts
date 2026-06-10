import type { UIMessage } from 'ai';

export type ChatSummary = { id: string; title: string; updatedAt: number };

const INDEX_KEY = 'chat:index';
const key = (id: string) => `chat:${id}`;
const hasWindow = () => typeof window !== 'undefined';

function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const part = firstUser?.parts.find((p) => p.type === 'text');
  const text = part && 'text' in part ? part.text : 'New chat';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// Single source of truth for chat persistence. Swap the bodies of these four
// methods for a fetch()-backed server implementation later; callers (Chat,
// Sidebar) never touch localStorage directly, so the UI doesn't change.
export const chatStore = {
  load(id: string): UIMessage[] {
    if (!hasWindow()) return [];
    const raw = localStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as UIMessage[]) : [];
  },
  save(id: string, messages: UIMessage[]) {
    if (!hasWindow() || messages.length === 0) return;
    localStorage.setItem(key(id), JSON.stringify(messages));
    const rest = chatStore.list().filter((c) => c.id !== id);
    const next = [{ id, title: deriveTitle(messages), updatedAt: Date.now() }, ...rest];
    localStorage.setItem(INDEX_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('chat-store-change'));
  },
  list(): ChatSummary[] {
    if (!hasWindow()) return [];
    const raw = localStorage.getItem(INDEX_KEY);
    const items = raw ? (JSON.parse(raw) as ChatSummary[]) : [];
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  remove(id: string) {
    if (!hasWindow()) return;
    localStorage.removeItem(key(id));
    const next = chatStore.list().filter((c) => c.id !== id);
    localStorage.setItem(INDEX_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('chat-store-change'));
  },
};
