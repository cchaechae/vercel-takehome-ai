import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  type UIMessage,
} from 'ai';
import { MAX_STEPS, prepareStep, SYSTEM, tools } from '@/lib/agent';
import { SYNTHESIS_MODELS } from '@/lib/models';

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const modelMessages = await convertToModelMessages(messages);

  const stream = createUIMessageStream({
    onError: () => 'Something went wrong. Please try again.',
    execute: async ({ writer }) => {
      let lastError: unknown;

      for (const model of SYNTHESIS_MODELS) {
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
            // Early failure (bad model, auth, provider down) surfaces here before
            // any content -> safe to fail over to the next provider.
            if (part.type === 'error') {
              if (!producedContent) throw new Error(part.errorText ?? 'model error');
              writer.write(part);
              return;
            }
            if (part.type === 'text-delta' || part.type.startsWith('tool')) {
              producedContent = true;
            }
            writer.write(part);
          }
          return; // success
        } catch (err) {
          lastError = err;
          console.warn(`[chat] model ${model} failed: ${(err as Error).message}`);
          if (producedContent) throw err; // mid-stream failure; can't cleanly retry
          // otherwise loop to the next model
        }
      }

      throw lastError ?? new Error('All models failed');
    },
  });

  return createUIMessageStreamResponse({ stream });
}
