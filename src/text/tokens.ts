/**
 * Finds the text delta in one item of an LLM stream, by duck typing, without importing any
 * LLM SDK. Returns undefined for items with no text (role headers, tool calls, usage, …).
 *
 * - strings, as they are;
 * - OpenAI Chat Completions chunks: `choices[0].delta.content`;
 * - OpenAI Responses events: `{ type: 'response.output_text.delta', delta }`;
 * - Anthropic Messages events: `{ type: 'content_block_delta', delta: { text } }`;
 * - Google Gemini responses: `.text` (a getter in `@google/genai`, a method in older SDKs);
 * - Vercel AI SDK `fullStream` parts: `{ type: 'text-delta', text | textDelta }`.
 */
export function textOf(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (typeof item !== 'object' || item === null) return undefined;
  const o = item as Record<string, unknown>;
  const choices = o.choices;
  if (Array.isArray(choices)) {
    const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta;
    return typeof delta?.content === 'string' ? delta.content : undefined;
  }
  switch (o.type) {
    case 'content_block_delta': {
      const delta = o.delta as { text?: unknown } | undefined;
      return typeof delta?.text === 'string' ? delta.text : undefined;
    }
    case 'response.output_text.delta':
      return typeof o.delta === 'string' ? o.delta : undefined;
    case 'text-delta': {
      const text = o.text ?? o.textDelta;
      return typeof text === 'string' ? text : undefined;
    }
  }
  if (typeof o.type === 'string') return undefined; // Another typed event: not text.
  try {
    const text = typeof o.text === 'function' ? (o.text as () => unknown).call(item) : o.text;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined; // Gemini's text() throws for a response without text (e.g. blocked).
  }
}
