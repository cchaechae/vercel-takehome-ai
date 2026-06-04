import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai';
import { MAX_STEPS, prepareStep, SYSTEM, tools } from '@/lib/agent';
import { withFailover } from '@/lib/failover';

export const maxDuration = 60;

/** Thrown once a stream has emitted content — the request can no longer fail over. */
class StreamCommittedError extends Error {}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const modelMessages = await convertToModelMessages(messages);

  const stream = createUIMessageStream({
    onError: () => 'Something went wrong. Please try again.',
    execute: async ({ writer }) => {
      await withFailover(
        async (model) => {
          const result = streamText({
            model,
            system: SYSTEM,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(MAX_STEPS),
            prepareStep,
          });

          let producedContent = false;
          try {
            const uiStream = result.toUIMessageStream({
              sendSources: true,
              onError: (e) => (e instanceof Error ? e.message : String(e)),
            });

            for await (const part of uiStream) {
              if (part.type === 'error') {
                // Early failure (bad model, auth, provider down) before any content
                // -> retryable, so fail over to the next provider.
                if (!producedContent) throw new Error(part.errorText ?? 'model error');
                writer.write(part);
                return;
              }
              if (part.type === 'text-delta' || part.type.startsWith('tool')) {
                producedContent = true;
              }
              writer.write(part);
            }
          } catch (err) {
            // A mid-stream failure can't be cleanly retried; mark it non-retryable.
            // Preserve the original error as `cause` so its stack survives in logs.
            if (producedContent) {
              throw new StreamCommittedError(err instanceof Error ? err.message : String(err), {
                cause: err,
              });
            }
            throw err;
          }
        },
        { isRetryable: (err) => !(err instanceof StreamCommittedError) },
      );
    },
  });

  return createUIMessageStreamResponse({ stream });
}
